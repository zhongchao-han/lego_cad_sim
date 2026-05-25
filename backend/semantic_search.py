"""本地向量语义搜索（替代 Meilisearch + DeepSeek 在线改写）。

零件检索文本由 backend/build_search_index.py 离线生成并编码成向量，落盘到
data/part_vectors.npy + data/part_search_meta.json。运行期本模块加载这两份文件，
对查询做同模型编码 + 余弦相似度排序（2000 余条向量，numpy 暴力点积即毫秒级，
无需独立向量数据库 / 服务）。

模型用多语种 e5（中英混检）：query 加 "query: " 前缀、passage 加 "passage: " 前缀，
这是 e5 系列的约定，缺前缀会明显掉点。模型与向量懒加载，首次搜索时才导入
sentence_transformers / torch，避免拖慢不用搜索的请求。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Optional

import numpy as np

logger = logging.getLogger(__name__)

MODEL_ID = "intfloat/multilingual-e5-small"

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VECTORS_FILE = os.path.join(_REPO_ROOT, "data", "part_vectors.npy")
META_FILE = os.path.join(_REPO_ROOT, "data", "part_search_meta.json")

_QUERY_PREFIX = "query: "
_PASSAGE_PREFIX = "passage: "

_model = None
_model_lock = threading.Lock()

_vectors: Optional[np.ndarray] = None  # [N, D] float32, L2 归一化
_meta: Optional[list[dict[str, Any]]] = None
_id_to_row: dict[str, int] = {}
_index_lock = threading.Lock()


def _get_model():
    """懒加载并复用 SentenceTransformer 单例（线程安全）。"""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from sentence_transformers import SentenceTransformer  # 重依赖，按需导入

                logger.info("[semantic_search] 加载向量模型 %s ...", MODEL_ID)
                _model = SentenceTransformer(MODEL_ID)
                logger.info("[semantic_search] 向量模型就绪。")
    return _model


def _encode(texts: list[str]) -> np.ndarray:
    """编码并 L2 归一化，返回 float32 [N, D]。"""
    model = _get_model()
    vecs = model.encode(
        texts,
        batch_size=64,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return np.asarray(vecs, dtype=np.float32)


def embed_passages(texts: list[str]) -> np.ndarray:
    """编码零件检索文本（建索引用）。"""
    return _encode([_PASSAGE_PREFIX + t for t in texts])


def embed_query(text: str) -> np.ndarray:
    """编码单条查询，返回 [D] 归一化向量。"""
    return _encode([_QUERY_PREFIX + text])[0]


def _load_index() -> tuple[np.ndarray, list[dict[str, Any]]]:
    """懒加载向量矩阵 + 元数据（线程安全，进程内缓存）。"""
    global _vectors, _meta, _id_to_row
    if _vectors is None or _meta is None:
        with _index_lock:
            if _vectors is None or _meta is None:
                if not (os.path.exists(VECTORS_FILE) and os.path.exists(META_FILE)):
                    raise FileNotFoundError(
                        "向量索引缺失，请先运行 python -m backend.build_search_index"
                    )
                _vectors = np.load(VECTORS_FILE).astype(np.float32, copy=False)
                with open(META_FILE, encoding="utf-8") as f:
                    _meta = json.load(f)
                _id_to_row = {m["id"]: i for i, m in enumerate(_meta)}
                logger.info("[semantic_search] 索引加载完成：%d 条向量。", len(_meta))
    return _vectors, _meta


def warmup() -> None:
    """后台预热：加载模型 + 索引，避免首次搜索阻塞。失败只记日志不抛。"""
    try:
        _load_index()
        _get_model()
    except Exception as exc:  # noqa: BLE001 - 预热失败不应影响服务启动
        logger.warning("[semantic_search] 预热失败（首次搜索会按需重试）: %s", exc)


def set_status(part_id: str, status: str) -> None:
    """复核保存后热更新某零件的状态（无需重建向量——文本/向量与状态无关）。"""
    if _meta is None:
        return
    doc_id = _doc_id(part_id)
    row = _id_to_row.get(doc_id)
    if row is not None:
        _meta[row]["status"] = status


def _doc_id(part_id: str) -> str:
    """与 build_search_index 一致的文档 id 规范化。"""
    return (
        part_id.lower()
        .replace(".dat", "")
        .replace("-", "_")
        .replace(" ", "_")
        .replace("/", "_")
    )


def search(query: str, limit: int = 50, verified_only: bool = True) -> list[dict[str, Any]]:
    """向量语义搜索 + part_num 精确加权。返回命中列表（含 score）。

    反例兜底：纯语义会把零件编号（如 "2855"）排得偏后，所以对 part_num 命中加权——
    编号精确相等 +1.0、编号/英文名/中文名子串 +0.3，确保编号检索稳定排到最前。
    """
    q = (query or "").strip()
    if not q:
        return []

    vectors, meta = _load_index()
    qvec = embed_query(q)
    scores = vectors @ qvec  # 余弦相似度（均已归一化）

    ql = q.lower()
    order = np.argsort(-scores)

    hits: list[dict[str, Any]] = []
    for idx in order:
        m = meta[idx]
        if verified_only and m.get("status") != "verified":
            continue

        score = float(scores[idx])
        part_num = str(m.get("part_num", "")).lower()
        name = str(m.get("name", "")).lower()
        zh_name = str(m.get("zh_name", "")).lower()
        if ql == part_num:
            score += 1.0
        elif ql in part_num or ql in name or ql in zh_name:
            score += 0.3

        hits.append(
            {
                "id": m["id"],
                "part_num": m.get("part_num", ""),
                "name": m.get("name", ""),
                "zh_name": m.get("zh_name", ""),
                "zh_desc": m.get("zh_desc", ""),
                "category": m.get("category", ""),
                "status": m.get("status", "pending"),
                "confidence": m.get("confidence", 1.0),
                "thumbnail_url": m.get("thumbnail_url", ""),
                "score": round(score, 4),
            }
        )

    # 加权后重排（精确命中的加成可能超过纯余弦的初始顺序）
    hits.sort(key=lambda h: h["score"], reverse=True)
    return hits[:limit]

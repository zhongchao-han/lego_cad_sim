"""离线构建零件向量索引（替代 sync_meili）。

对每个零件组合一段「中文为主」的检索文本（zh_name + zh_desc + 英文名 + 编号 +
类别 + 口语同义词/典型用途增强），用多语种 e5 编码成向量，落盘：
  data/part_vectors.npy        —— [N, D] float32，L2 归一化，行序与 meta 对齐
  data/part_search_meta.json   —— [{id, part_num, name, zh_name, zh_desc,
                                    category, status, confidence, thumbnail_url,
                                    has_sites}]，运行期 search 直接取用

同义词/用途增强是召回的关键杠杆：LDraw 把起重机回转大盘叫 "Turntable"，库里中文
只有「转盘」甚至「零件」，用户却会搜「起重机旋转的大齿轮」。把这些口语词写进检索
文本，向量才能把口语查询拉近到正确零件。

用法：python -m backend.build_search_index
"""
from __future__ import annotations

import json
import logging
import os

import numpy as np

from backend.category import categorize, get_part_name as _get_part_name
from backend import semantic_search

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(_REPO_ROOT, "data", "ldraw_port_configs.json")
ZH_NAMES_FILE = os.path.join(_REPO_ROOT, "data", "part_names_zh.json")
_LDRAW_LIB_ROOT = os.environ.get("LDRAW_PARTS_ROOT", os.path.join(_REPO_ROOT, "ldraw_lib"))
LDRAW_PARTS_DIR = os.path.join(_LDRAW_LIB_ROOT, "parts")

# 类别 → 中文别名（拼进检索文本，让按品类的口语查询也能命中）
CATEGORY_ZH: dict[str, str] = {
    "Pin": "销 插销 销钉 连接销",
    "Axle": "轴 传动轴 十字轴",
    "Connector": "连接器 接头 转接",
    "Beam": "梁 横梁 举臂 框架",
    "Gear": "齿轮 传动 啮合 齿",
    "Wheel": "车轮 轮子 轮毂 轮胎",
    "Plate": "平板 板 底板",
    "Tile": "平滑片 光面砖 饰面",
    "Brick": "砖 积木块 砖块",
    "Panel": "面板 外壳 整流罩 覆盖件",
    "Cylinder": "气缸 减震器 避震",
    "Pneumatic": "气动件 气动",
    "Steering": "转向件 转向",
    "Electric": "电动件 电机 马达",
    "Sticker": "贴纸 贴花",
    "Other": "零件",
}

# 英文名关键词 → 口语同义词 / 典型用途。命中（英文名含 key）即把这些词拼进检索文本。
# 这是「起重机旋转的大齿轮 → 转盘」这类口语检索能命中的核心。
KEYWORD_AUGMENT: list[tuple[str, str]] = [
    ("turntable", "转盘 回转盘 回转支承 转台 起重机回转 吊车旋转 挖掘机回转 上车旋转 旋转大齿轮 大齿轮盘"),
    ("differential", "差速器 差速齿轮 差速箱"),
    ("universal joint", "万向节 十字万向节 传动万向节"),
    ("worm", "蜗杆 蜗轮蜗杆 自锁传动"),
    ("rack", "齿条 直线齿条 直线传动"),
    ("shock absorber", "减震器 避震 悬挂 弹簧减震"),
    ("steering", "转向 方向 转向机构"),
    ("pulley", "滑轮 皮带轮 带轮"),
    ("tread", "履带 坦克履带 链板"),
    ("track ", "履带 轨道"),
    ("propeller", "螺旋桨 桨叶 旋翼"),
    ("hook", "吊钩 挂钩 起重钩"),
    ("chain", "链条 传动链 链节"),
    ("crank", "曲柄 摇把 曲轴"),
    ("hub", "轮毂 轮圈"),
    ("bevel", "锥齿轮 伞齿轮"),
    ("clutch", "离合器 离合"),
    ("cam", "凸轮"),
    ("sprocket", "链轮 链齿轮"),
    ("baseplate", "底板 大底板 基板 承载板"),
    ("liftarm", "举臂 力臂 横臂 连杆"),
]


def _doc_id(part_id: str) -> str:
    return (
        part_id.lower()
        .replace(".dat", "")
        .replace("-", "_")
        .replace(" ", "_")
        .replace("/", "_")
    )


def compose_search_text(name: str, zh_name: str, zh_desc: str, category: str) -> str:
    """把多来源信息拼成一段中文为主的检索文本。"""
    parts: list[str] = []
    if zh_name:
        parts.append(zh_name)
    if zh_desc:
        parts.append(zh_desc)
    if name:
        parts.append(name)  # 英文 LDraw 名（e5 多语种，英文查询也吃）
    parts.append(CATEGORY_ZH.get(category, "零件"))

    low = name.lower()
    for kw, aug in KEYWORD_AUGMENT:
        if kw in low:
            parts.append(aug)

    return " ".join(p for p in parts if p)


def main() -> None:
    with open(DATA_FILE, encoding="utf-8") as f:
        config_data: dict = json.load(f)

    zh_map: dict = {}
    if os.path.exists(ZH_NAMES_FILE):
        with open(ZH_NAMES_FILE, encoding="utf-8") as f:
            zh_map = json.load(f)
    else:
        logger.warning("未找到 %s，中文字段留空（建议先跑 backend.gen_zh_names）", ZH_NAMES_FILE)

    meta: list[dict] = []
    texts: list[str] = []
    for part_id, cfg in config_data.items():
        part_num = part_id.lower().replace(".dat", "")
        name = _get_part_name(part_id, LDRAW_PARTS_DIR)
        category = categorize(name)
        zh = zh_map.get(part_id, {})
        zh_name = zh.get("zh_name", "")
        zh_desc = zh.get("zh_desc", "")

        meta.append(
            {
                "id": _doc_id(part_id),
                "part_num": part_num,
                "name": name,
                "zh_name": zh_name,
                "zh_desc": zh_desc,
                "category": category,
                "status": cfg.get("status", "pending"),
                "confidence": cfg.get("confidence", 1.0),
                "thumbnail_url": f"/api/thumbnails/{part_num}.png",
                "has_sites": "sites" in cfg,
            }
        )
        texts.append(compose_search_text(name, zh_name, zh_desc, category))

    logger.info("编码 %d 个零件检索文本（模型 %s）...", len(texts), semantic_search.MODEL_ID)
    vectors = semantic_search.embed_passages(texts)
    logger.info("向量维度 %s", vectors.shape)

    np.save(semantic_search.VECTORS_FILE, vectors)
    with open(semantic_search.META_FILE, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    logger.info(
        "已写入 %s（%.1f KB）+ %s",
        os.path.basename(semantic_search.VECTORS_FILE),
        vectors.nbytes / 1024,
        os.path.basename(semantic_search.META_FILE),
    )


if __name__ == "__main__":
    main()

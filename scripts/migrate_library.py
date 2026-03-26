"""
migrate_library.py
==================
全库 Z 轴约定迁移脚本：
  1. 保留所有 verified 条目（人工核验数据）
  2. 清除所有 non-verified 旧端口数据
  3. 用新版 discover_ports（Y 列 → Z 轴约定）重新计算所有科技零件
  4. 将结果写回 ldraw_port_configs.json
"""

import os
import sys
import json
import logging
from typing import Any

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.geometry_processor import GeometryProcessor
from backend.port_library_manager import PortLibraryManager
from backend.site_utils import cluster_ports_into_sites, sites_to_response

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# ─── 配置 ─────────────────────────────────────────────────────────────────────
LDRAW_ROOT   = "ldraw_lib"
DATA_PATH    = "data/ldraw_port_configs.json"
PARTS_DIR    = os.path.join(LDRAW_ROOT, "parts")

# 科技件识别关键词（扫描文件内容）
TECHNIC_PRIMITIVES_KEYWORDS = {
    "peghole", "axlehole", "pin.dat", "axle.dat",
    "connhole", "beamhole", "confric",
}
# ──────────────────────────────────────────────────────────────────────────────


def scan_all_parts(parts_dir: str) -> list[str]:
    """递归扫描 parts/ 目录，返回所有 .dat 零件。"""
    found: list[str] = []
    for root, _, files in os.walk(parts_dir):
        for fname in files:
            if not fname.lower().endswith(".dat"):
                continue
            full = os.path.join(root, fname)
            rel  = os.path.relpath(full, parts_dir)
            # 全量扫描，不再进行前缀关键字过滤，依靠 discover_ports 结果来决定是否入库
            found.append(rel)
    return found


def migrate() -> None:
    # ── 1. 加载现有数据，提取 verified 条目 ────────────────────────────────────
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        existing: dict[str, Any] = json.load(f)

    verified = {k: v for k, v in existing.items() if v.get("status") == "verified"}
    logger.info(f"保留 {len(verified)} 个 verified 条目，清除其余 {len(existing) - len(verified)} 条旧数据。")

    # ── 2. 备份并构建新数据库（清空非 verified 条目或全量更新） ─────────────────
    # 根据 v3.1 表面分裂协议，强制重新计算所有零件以保证几何一致性
    new_db: dict[str, Any] = {}
    
    # 自动备份旧数据
    backup_path = DATA_PATH + ".bak"
    with open(backup_path, "w", encoding="utf-8") as bf:
        json.dump(existing, bf, ensure_ascii=False)
    logger.info(f"已创建旧数据备份: {backup_path}")

    # ── 3. 扫描所有零件 ──────────────────────────────────────────────────────
    logger.info("正在扫描 LDraw 零件库...")
    technic_parts = scan_all_parts(PARTS_DIR)
    logger.info(f"找到 {len(technic_parts)} 个零件，开始全量重计端口（强制应用新 Z 轴与分裂约定）...")

    geo_proc = GeometryProcessor(ldraw_path=LDRAW_ROOT)
    success = 0

    for i, rel_path in enumerate(technic_parts):
        part_id = rel_path.replace("\\", "/")
        # [v3.1 Fix] 不再跳过 verified，因为旧的 verified 数据可能不包含表面分裂端口

        try:
            raw_ports = geo_proc.discover_ports(rel_path)
        except Exception as exc:
            logger.warning(f"[{part_id}] discover_ports 失败: {exc}")
            continue

        if not raw_ports:
            continue

        try:
            computed_sites = cluster_ports_into_sites(raw_ports, part_id)
            sites_resp     = sites_to_response(computed_sites)
        except Exception as exc:
            logger.warning(f"[{part_id}] 聚类失败: {exc}")
            sites_resp = []

        new_db[part_id] = {
            "status":     "pending",
            "confidence": 0.8,
            "ports":      raw_ports,
            "sites":      sites_resp,
        }
        success += 1

        if (i + 1) % 200 == 0:
            logger.info(f"  进度: {i + 1}/{len(technic_parts)} 已处理，成功入库 {success} 个...")

    # ── 4. 写回 ────────────────────────────────────────────────────────────────
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(new_db, f, ensure_ascii=False, indent=2)

    logger.info(f"迁移完成。总条目数: {len(new_db)}，新增/更新: {success}，保留 verified: {len(verified)}。")


if __name__ == "__main__":
    migrate()

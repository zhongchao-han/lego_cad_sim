"""
site_utils.py
=============
将扁平 Port 列表按物理位点聚类，生成 Site 对象集合。

设计原则：
- 零侵入：不修改 ldraw_port_configs.json 的现有结构。
- 动态聚类：在查询时计算 Site，位置欧氏距离 < SITE_MERGE_THRESHOLD 的端口归并为同一 Site。
- SRP：本模块只负责聚类，不负责端口解析或 I/O。
"""

import logging
from typing import Any, Dict, List

import numpy as np

from backend.port import Port, Site
from backend.port_semantics import get_interface

logger = logging.getLogger(__name__)

# 同一 Site 内，两端口位置的欧氏距离上限（单位：米）
# 0.0001m = 0.1mm ≈ 0.25 LDU，足以消除浮点抖动，同时不会误合并相邻孔位
SITE_MERGE_THRESHOLD: float = 0.0001


def _load_port_from_dict(p: Dict[str, Any]) -> Port | None:
    """将 JSON 字典转换为强类型 Port 对象，无法识别的类型返回 None。"""
    logger.debug(
        f"[DEBUG] _load_port_from_dict: name={p.get('name')}, type={p.get('type')}"
    )
    interface = get_interface(p.get("type", ""))
    if interface is None:
        logger.warning(
            f"[WARN] 无法识别的端口类型: {p.get('type')}，将跳过（不归入 Site）"
        )
        return None
    return Port(
        name=p.get("name", "unknown"),
        interface=interface,
        position=np.array(p["position"], dtype=float),
        rotation=np.array(p["rotation"], dtype=float),
        port_type=p.get("type", ""),
        is_manually_adjusted=p.get("is_manually_adjusted", False),
        part_context=p.get("part_context"),
    )


def cluster_ports_into_sites(
    ports_raw: List[Dict[str, Any]], part_id: str
) -> List[Site]:
    """
    将扁平的端口字典列表聚类为 Site 对象列表。

    算法：贪心近邻聚类 O(n²)，n 为端口数量。
    对于 LEGO Technic 零件，端口数量通常 < 20，性能足够。

    Args:
        ports_raw: 来自 ldraw_port_configs.json 的原始端口 dict 列表。
        part_id:   零件 ID，用于生成 Site 的唯一标识。

    Returns:
        已聚类的 Site 列表。每个 Site 至少含 1 个 Port。
    """
    logger.debug(
        f"[DEBUG] cluster_ports_into_sites: part_id={part_id}, port_count={len(ports_raw)}"
    )
    if not ports_raw:
        return []

    # 把原始 dict 转为强类型 Port（识别失败的跳过）
    typed_ports: List[Port] = []
    for raw in ports_raw:
        p = _load_port_from_dict(raw)
        if p:
            typed_ports.append(p)

    # 贪心聚类：已被分配到某个 Site 的端口打上标记
    assigned: List[bool] = [False] * len(typed_ports)
    sites: List[Site] = []

    for i, port_i in enumerate(typed_ports):
        if assigned[i]:
            continue  # 已归组，跳过

        # 创建新 Site，以当前端口位置为核心
        site_id = f"{part_id}_site{len(sites)}"
        site = Site(id=site_id)
        site.add_port(port_i)
        assigned[i] = True

        # 扫描后续端口，若足够近则合并入同一 Site
        for j in range(i + 1, len(typed_ports)):
            if assigned[j]:
                continue
            dist = float(np.linalg.norm(port_i.position - typed_ports[j].position))
            if dist < SITE_MERGE_THRESHOLD:
                logger.debug(
                    f"[DEBUG] 端口 {typed_ports[j].name} 与 {port_i.name} 距离 {dist:.6f}m < 阈值，合并到 {site_id}"
                )
                site.add_port(typed_ports[j])
                assigned[j] = True

        sites.append(site)
        logger.debug(f"[DEBUG] 创建 Site {site_id}，包含 {len(site.ports)} 个端口")

    logger.info(
        f"[INFO] part_id={part_id}：{len(typed_ports)} 个端口聚类为 {len(sites)} 个 Site"
    )
    return sites


def sites_to_response(sites: List[Site]) -> List[Dict[str, Any]]:
    """
    将 Site 列表序列化为 API 友好的字典格式。

    返回结构:
        [
            {
                "id": "site_id",
                "position": [x, y, z],
                "ports": [
                    { "name": ..., "type": ..., "position": ..., "rotation": ... }
                ]
            }
        ]
    """
    result = []
    for site in sites:
        result.append(
            {
                "id": site.id,
                "position": site.position.tolist(),
                "occupied_by": site.occupied_by,
                "ports": [p.to_dict() for p in site.ports],
            }
        )
    return result

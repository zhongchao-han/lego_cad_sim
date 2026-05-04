"""
mass_estimator.py — L51 单零件质量与质心估算
=============================================
trimesh.volume + ABS 密度（≈ 1050 kg/m³，LEGO 实测约 1.04-1.06 g/cm³）。

GLB 是 ensure_mesh_exists 烘出来的；本模块仅读，不烘。如果 GLB 还没烘
（PartLibraryPanel 列表的 part 在用户没点过的情况下不会触发烘焙），lazy
路径会跳过 → 返 None，前端按 None 走默认 0.001 kg fallback。

trimesh.volume 在非 watertight mesh 上可能返负值或 0：v1 用 bbox 体积 ×
0.5 实心系数 fallback。误差量级 ~30%，对 v1 整体 COM gizmo 足够；要更精
准的留给 L51b 做凸壳重建或 watertight 修复。

下游：backend/server.py /api/get_verified_parts 把 (mass_kg, com_local)
注入每条记录。前端 PartCatalogEntry 接住，存到 store.partCatalog 供
staticsMath 计算整体 COM。
"""
from __future__ import annotations

import functools
import logging
import os
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ABS 塑料密度（kg/m³）。LEGO 实测约 1040-1060；取 1050 作中值。
ABS_DENSITY_KG_M3 = 1050.0
# bbox fallback 实心系数：mesh 不 watertight 时假设零件平均填充 50%
SOLIDITY_FACTOR_FALLBACK = 0.5
# 体积合理性阈值：< 此值（1 mm³）视为 trimesh.volume 失败，走 fallback
MIN_REASONABLE_VOLUME_M3 = 1e-9


@functools.lru_cache(maxsize=4096)
def estimate_mass_com(glb_abs_path: str) -> Optional[Tuple[float, Tuple[float, float, float]]]:
    """
    返回 (mass_kg, com_local_xyz) 或 None（GLB 不存在 / 解析失败）。

    com_local 是 part 在自身局部坐标系下的质心，单位 SI 米。
    """
    if not glb_abs_path or not os.path.exists(glb_abs_path):
        return None

    try:
        import trimesh  # 延迟 import；测试环境可能不需要 trimesh
    except ImportError:
        logger.warning("[mass_estimator] trimesh 未安装；跳过质量估算")
        return None

    try:
        loaded = trimesh.load(glb_abs_path, force='mesh')
    except Exception as exc:  # noqa: BLE001
        logger.warning("[mass_estimator] trimesh.load 失败 %s: %s", glb_abs_path, exc)
        return None

    if loaded is None or not hasattr(loaded, 'vertices') or len(loaded.vertices) == 0:
        return None

    # trimesh.volume 在 watertight mesh 上是真体积；非 watertight 给负值或 0
    volume = float(getattr(loaded, 'volume', 0.0))
    com: np.ndarray
    if volume > MIN_REASONABLE_VOLUME_M3:
        try:
            com = np.array(loaded.center_mass, dtype=float)
        except Exception:  # noqa: BLE001
            com = np.array(loaded.centroid, dtype=float)
    else:
        # bbox fallback：体积 = bbox · solidity；COM = bbox 中心
        bbox = loaded.bounds  # shape (2, 3)
        size = bbox[1] - bbox[0]
        volume = float(size[0] * size[1] * size[2] * SOLIDITY_FACTOR_FALLBACK)
        com = np.array((bbox[0] + bbox[1]) / 2.0, dtype=float)
        logger.debug(
            "[mass_estimator] %s 非 watertight，bbox fallback: volume=%.3em³",
            glb_abs_path, volume,
        )

    if volume <= MIN_REASONABLE_VOLUME_M3:
        # bbox 也异常（退化几何）—— 拒绝估算
        return None

    mass_kg = volume * ABS_DENSITY_KG_M3
    return mass_kg, (float(com[0]), float(com[1]), float(com[2]))


def estimate_mass_com_for_part(
    mesh_manager,
    part_id: str,
    color_code: int = 7,
) -> Optional[Tuple[float, Tuple[float, float, float]]]:
    """
    便捷：从 part_id + color_code 通过 MeshAssetManager 拿绝对 GLB 路径，再算。
    """
    abs_path = mesh_manager.get_absolute_glb_path(part_id, color_code)
    return estimate_mass_com(abs_path)

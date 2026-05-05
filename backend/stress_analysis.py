"""
stress_analysis.py — L51b PR-C 真应力近似（von Mises + ABS 屈服阈值）
========================================================================
把 statics_solver 算出的 reaction force（N）投到 port 圆截面上，按基础
材料力学公式得 σ_normal / τ_shear / σ_von_mises，再除 ABS 屈服强度
得到 safety_ratio：

  axial_dir_world = R_world(parent) · port_parent.rotation[:, 2]   # port Z 轴 = 插入方向
  F_axial = F · axial_dir_world          # 标量；> 0 拉、< 0 压
  F_lateral = |F − F_axial · axial_dir|  # 横向剪切

  A = π · radius²                        # 圆截面（仅 Profile.CYLINDER 有意义）
  σ = |F_axial| / A
  τ = F_lateral / A
  σ_vm = √(σ² + 3·τ²)                    # plane stress 简化的 distortion-energy 准则
  safety = σ_vm / σ_yield_ABS            # < 1 = 安全；> 1 = 屈服

适用边界（明确）：
  - 仅 Profile.CYLINDER（pin / peghole / fric_pin 等）有意义。
    CROSS（轴 / 轴孔）截面是十字形，σ_vm 公式不适用，本模块返 None。
    STUD / fixed merged 同样返 None。
  - 简化 τ 用 F_lateral / A（均匀分布）。圆截面真实 τ_max = (4/3) · F/A，
    v1 不引入这个常数（量级正确即可，告警边界没那么敏感）。
  - 不算 torque 引起的 σ —— LEGO 销受扭通常很小，量级远低于轴向 / 横向。
    若要完整：σ_torsion = M · radius / J（J = π·r⁴/2），可作 v2 加。
  - ABS 屈服强度按 LEGO 实测 40 MPa（实际范围 38-45 取中值）。

设计目的（Honest）：
  LEGO Technic 是玩具，常态使用不到屈服。本模块的实用价值偏教育性 —— 给
  做工程模型的高级用户看"哪根销开始吃力"。所以 v1 严格但保守：
  CYLINDER-only、von Mises 仅含 σ + τ、yield 取保守中值。
"""
from __future__ import annotations

import logging
import math
from typing import Any, Dict, Optional

import numpy as np

from backend.port_semantics import Profile

logger = logging.getLogger(__name__)

# ── 物性常量 ────────────────────────────────────────────────────────────────
# LEGO ABS 屈服强度：实测范围 38-45 MPa，取保守中值 40 MPa。
ABS_YIELD_PA = 40e6

# safety_ratio 显示阈值（与前端可视化一致）：
#   < 0.30 → green: 几乎无负载
#   0.30 ~ 0.70 → yellow: 中度受力
#   0.70 ~ 1.00 → orange/red: 接近屈服，需注意
#   >= 1.00 → 屈服失效
SAFETY_WARNING = 0.70
SAFETY_FAILED  = 1.00


def _normalize(v: np.ndarray) -> Optional[np.ndarray]:
    n = float(np.linalg.norm(v))
    if n < 1e-12:
        return None
    return v / n


def analyze_edge_stress(
    edge,
    parent_world_T: np.ndarray,
    force_world: np.ndarray,
) -> Optional[Dict[str, Any]]:
    """
    单条 edge 的 stress 估算。返 dict 或 None（截面不适用 / 数据缺失）。

    Args:
        edge: ConnectionEdge。需 port_parent.interface.{profile, radius} +
              port_parent.rotation 用于轴向。
        parent_world_T: 4x4 父零件世界变换。用 R 部分把局部 axial 转世界。
        force_world: 作用在该 edge 上的 3D reaction force，世界系下单位 N。

    Returns:
        {
          axial_force_N, shear_force_N,
          normal_stress_pa, shear_stress_pa, von_mises_pa,
          safety_ratio,        # σ_vm / σ_yield
          yields,              # bool, safety_ratio >= 1
        }
        非圆截面 / 接口缺失 → None。
    """
    iface = getattr(edge.port_parent, 'interface', None)
    if iface is None or iface.profile != Profile.CYLINDER:
        return None
    radius = float(iface.radius)
    if radius <= 0:
        return None

    # axial 方向 = port_parent.rotation 的第 3 列（Z 轴 = 插入方向，仓库约定）
    rot_local = np.asarray(edge.port_parent.rotation)
    if rot_local.shape != (3, 3):
        return None
    axial_local = rot_local[:, 2]
    axial_world_raw = parent_world_T[:3, :3] @ axial_local
    axial_unit = _normalize(axial_world_raw)
    if axial_unit is None:
        return None

    # 分解 F = F_axial · axial_unit + F_lateral_vec
    F = np.asarray(force_world, dtype=float)
    F_axial = float(np.dot(F, axial_unit))
    F_lateral_vec = F - F_axial * axial_unit
    F_lateral = float(np.linalg.norm(F_lateral_vec))

    A = math.pi * radius * radius   # 圆截面面积，m²
    sigma = abs(F_axial) / A        # Pa
    tau = F_lateral / A             # Pa（v1 简化均匀分布；圆截面真值有 4/3 系数）
    von_mises = math.sqrt(sigma * sigma + 3.0 * tau * tau)
    safety = von_mises / ABS_YIELD_PA

    return {
        'axial_force_N':    F_axial,
        'shear_force_N':    F_lateral,
        'normal_stress_pa': sigma,
        'shear_stress_pa':  tau,
        'von_mises_pa':     von_mises,
        'safety_ratio':     safety,
        'yields':           safety >= SAFETY_FAILED,
    }


def enrich_reactions_with_stress(
    reactions: Dict[str, Dict[str, Any]],
    topo_manager,
) -> Dict[str, Dict[str, Any]]:
    """
    给 statics_solver 的 reactions 字典就地补 'stress' 字段（圆截面 only）。

    edge_key 形如 "parent::child::networkx_key"，由 solver 写入。本函数复用
    topology graph 找到对应 ConnectionEdge + 父零件 world transform，跑
    analyze_edge_stress 拿 stress dict 塞进去。

    返回同一 dict 引用（in-place），失败的 edge stress=None 不抛错。
    """
    G = topo_manager.graph
    # 建 (parent, child, key) → edge 反查
    edge_lookup: Dict[str, Any] = {}
    part_T: Dict[str, np.ndarray] = {}
    for pid, attr in G.nodes(data=True):
        node = attr.get('data')
        part_T[pid] = getattr(node, 'global_transform', np.eye(4)) if node else np.eye(4)
    for u, v, key, attr in G.edges(keys=True, data=True):
        edge_lookup[f"{u}::{v}::{key}"] = attr.get('data')

    for edge_key, rxn in reactions.items():
        edge = edge_lookup.get(edge_key)
        if edge is None:
            rxn['stress'] = None
            continue
        try:
            stress = analyze_edge_stress(
                edge,
                part_T.get(rxn['parent_id'], np.eye(4)),
                np.asarray(rxn['force']),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[stress] edge %s 计算失败: %s", edge_key, exc)
            stress = None
        rxn['stress'] = stress
    return reactions

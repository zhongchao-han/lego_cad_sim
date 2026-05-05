"""
statics_solver.py — L51b PR-B 反力求解器
==========================================
对当前 TopologyManager.graph 做静态平衡分析，给每条 ConnectionEdge 算出
一个 6D wrench (Fx Fy Fz Mx My Mz)，让前端可视化"哪条销 / 轴正在受力"。

数学：
  - 输入：N 个零件（各自 mass + world transform），M 条 edge（各自 endpoints +
    world joint anchor）
  - 每个零件 6 个静态平衡方程（Σ F = 0、Σ τ = 0），共 6N 方程
  - 变量：每条 edge 的 6D wrench → 6M 变量；外加 6 维 ground anchor wrench 锚定
    Y 最低的零件，避免 6-DOF 刚体自由模式让系统欠定无解
  - 重力：每零件世界 -Y 方向 m·g 力（Y-up 约定）
  - 求解：numpy.linalg.lstsq，超定走最小二乘，欠定（带闭环冗余）走最小范数

v1 简化（明确）：
  - 所有 edge 当 6 DOF fixed joint 处理。joint-type-aware（revolute 释放轴向
    torque、prismatic 释放轴向 force）留 v2
  - 不考虑 joint 几何约束的"实际可承载"差异（销径/材料强度等）

输出：dict 形如
  { edge_key: { force: [Fx,Fy,Fz], torque: [Mx,My,Mz], magnitude_force,
                magnitude_torque, parent_id, child_id, anchor_world } }

使用：
  reactions = solve_reactions(topo_manager, mesh_manager)
"""
from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)

GRAVITY_M_S2 = 9.81  # 标准重力加速度
DEFAULT_MASS_KG = 0.001  # 与 L51 v1 staticsMath 同源 fallback


def _world_anchor(part_world_T: np.ndarray, port_local_pos: np.ndarray) -> np.ndarray:
    """把 port_parent 的局部位置转到世界系作为 edge 的 wrench 作用点。"""
    return part_world_T[:3, :3] @ port_local_pos + part_world_T[:3, 3]


def _skew(v: np.ndarray) -> np.ndarray:
    """生成 3D 向量的反对称矩阵 [v]_×（叉乘表示）。"""
    return np.array([
        [0, -v[2], v[1]],
        [v[2], 0, -v[0]],
        [-v[1], v[0], 0],
    ])


def solve_reactions(
    topo_manager,
    mesh_manager=None,
    mass_provider=None,
) -> Dict[str, Dict[str, Any]]:
    """
    跑一次反力求解，返回每条 edge 的 6D wrench。

    Args:
        topo_manager: TopologyManager 实例。其 .graph 应为已通过 build_spanning_tree
                      或类似手段保证 PartNode data 不丢的 MultiDiGraph。
        mesh_manager: 可选。MeshAssetManager；用于 mass_estimator 查每零件 mass。
        mass_provider: 可选回调 (part_id, ldraw_id) -> mass_kg。默认 None 走
                       mesh_manager.estimate_mass_com，再缺再走 DEFAULT_MASS_KG。

    Returns:
        dict 形如 { edge_key: { force, torque, magnitude_force, magnitude_torque,
                  parent_id, child_id, anchor_world } }；空图 / 单零件返 {}。
    """
    G = topo_manager.graph
    parts = list(G.nodes(data=True))
    if len(parts) < 1:
        return {}

    # ── 1. Index parts，收集 mass + world transform ─────────────────────────
    part_index: Dict[str, int] = {}
    masses: List[float] = []
    world_T: List[np.ndarray] = []
    for i, (pid, attr) in enumerate(parts):
        part_index[pid] = i
        node = attr.get('data')
        T = getattr(node, 'global_transform', np.eye(4)) if node else np.eye(4)
        world_T.append(T)
        # mass：优先 callback → mass_estimator (lazy via mesh_manager) → fallback
        m = DEFAULT_MASS_KG
        if mass_provider is not None:
            try:
                ldraw_id = getattr(node, 'ldraw_id', None)
                m_query = mass_provider(pid, ldraw_id)
                if m_query and m_query > 0:
                    m = float(m_query)
            except Exception:  # noqa: BLE001
                pass
        elif mesh_manager is not None and node is not None:
            try:
                from backend.mass_estimator import estimate_mass_com_for_part
                ldraw_id = getattr(node, 'ldraw_id', None)
                if ldraw_id:
                    res = estimate_mass_com_for_part(mesh_manager, ldraw_id, color_code=7)
                    if res is not None and res[0] > 0:
                        m = float(res[0])
            except Exception:  # noqa: BLE001
                pass
        masses.append(m)

    N = len(parts)

    # ── 2. 收集 edges 数据 ───────────────────────────────────────────────────
    # 用 (u, v, key) 作为唯一标识；MultiDiGraph 同对零件可能多边，每边独立 wrench
    edges_meta: List[Dict[str, Any]] = []
    for u, v, key, attr in G.edges(keys=True, data=True):
        edge = attr.get('data')
        if edge is None:
            continue
        # 父端口在世界系下的位置 = R_parent · port.position + p_parent
        try:
            anchor = _world_anchor(world_T[part_index[u]], np.asarray(edge.port_parent.position))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[statics_solver] 无法算 edge %s→%s anchor: %s", u, v, exc)
            continue
        edges_meta.append({
            'edge_key': f"{u}::{v}::{key}",
            'parent_id': u,
            'child_id': v,
            'anchor_world': anchor,
        })

    M = len(edges_meta)

    # ── 3. 装配 Ax = b ──────────────────────────────────────────────────────
    # 变量：6M edge wrench + 6 ground wrench；编号：[edge_0_W (6D), edge_1_W (6D), ..., ground_W (6D)]
    # 方程：每零件 6 个（3 force + 3 torque）
    n_vars = 6 * (M + 1)
    n_eqs = 6 * N
    A = np.zeros((n_eqs, n_vars))
    b = np.zeros(n_eqs)

    # 每零件的 force 平衡 = +Σ child-edge force −Σ parent-edge force +ground force = mg·ŷ_down
    # 每零件的 torque 平衡 = +Σ child-edge (anchor-com)×F + child-edge M
    #                       −Σ parent-edge (anchor-com)×F − parent-edge M
    #                       +ground (com_origin)×F + ground M  = 0  （重力作用点≈com，简化为 part origin）
    # 使用 Y-up：重力 = (0, -m·g, 0) in world。
    for i, (pid, attr) in enumerate(parts):
        com_world = world_T[i][:3, 3]  # 简化：以 part origin 当 com 作用点（v2 可加 com_local 修正）
        row_F = 6 * i        # 这一零件 force 平衡 3 行
        row_T = 6 * i + 3    # 这一零件 torque 平衡 3 行
        # Σ_j (sign_j · F_edge_j) + (0, -m·g, 0) = 0  ⇒  移项 Σ_j (...) = (0, +m·g, 0)
        # Y-up 约定下 b 的 Y 分量是 +m·g（让 edge 把零件往上托），不是 -m·g。
        b[row_F + 1] = +masses[i] * GRAVITY_M_S2

        for k, em in enumerate(edges_meta):
            sign = 0
            if em['child_id'] == pid:
                sign = +1
            elif em['parent_id'] == pid:
                sign = -1
            if sign == 0:
                continue
            col_F = 6 * k        # edge k force 3 列
            col_T = 6 * k + 3    # edge k torque 3 列
            # Force 平衡：sign · F_edge
            A[row_F:row_F + 3, col_F:col_F + 3] += sign * np.eye(3)
            # Torque 平衡：sign · ((anchor − com) × F_edge + M_edge)
            r = em['anchor_world'] - com_world
            A[row_T:row_T + 3, col_F:col_F + 3] += sign * _skew(r)
            A[row_T:row_T + 3, col_T:col_T + 3] += sign * np.eye(3)

    # Ground anchor：作用在 Y 最低的零件，最后 6 列
    if N > 0:
        y_coords = [world_T[i][1, 3] for i in range(N)]
        ground_idx = int(np.argmin(y_coords))
        col_gF = 6 * M
        col_gT = 6 * M + 3
        row_F = 6 * ground_idx
        row_T = 6 * ground_idx + 3
        # ground 在 grounded part 的世界 origin 附近作用（简化）
        com_g = world_T[ground_idx][:3, 3]
        # 用 part origin 当 anchor → r = 0 → torque arm = 0
        A[row_F:row_F + 3, col_gF:col_gF + 3] += np.eye(3)
        A[row_T:row_T + 3, col_gT:col_gT + 3] += np.eye(3)
        # （为 anchor != origin 留接口，目前 r=0 不出现叉乘项）
        _ = com_g  # placeholder

    # ── 4. 求解（lstsq 处理超定/欠定） ────────────────────────────────────
    if n_vars == 0 or n_eqs == 0:
        return {}
    try:
        x, residuals, rank, _sv = np.linalg.lstsq(A, b, rcond=None)
    except np.linalg.LinAlgError as exc:
        logger.error("[statics_solver] lstsq 失败: %s", exc)
        return {}

    # ── 5. 拆解结果 ─────────────────────────────────────────────────────────
    out: Dict[str, Dict[str, Any]] = {}
    for k, em in enumerate(edges_meta):
        col_F = 6 * k
        F = x[col_F:col_F + 3]
        T = x[col_F + 3:col_F + 6]
        f_mag = float(np.linalg.norm(F))
        t_mag = float(np.linalg.norm(T))
        out[em['edge_key']] = {
            'parent_id': em['parent_id'],
            'child_id': em['child_id'],
            'anchor_world': [float(em['anchor_world'][0]),
                              float(em['anchor_world'][1]),
                              float(em['anchor_world'][2])],
            'force':  [float(F[0]), float(F[1]), float(F[2])],
            'torque': [float(T[0]), float(T[1]), float(T[2])],
            'magnitude_force':  f_mag,
            'magnitude_torque': t_mag,
        }

    logger.info(
        "[statics_solver] 解出 %d 条 edge 反力（rank=%d, residual=%s）",
        M, rank, residuals.tolist() if residuals.size else 'n/a',
    )
    return out

"""
auto_latch_scanner.py
======================
单一职责 (SRP)：给定两个零件的 Site 配置与它们各自的世界变换，
自动扫描并找出所有在物理上接近且语义兼容的 Site 对，返回待注册的
ConnectionEdge 列表。

与 TopologyManager 解耦：本模块不持有状态，也不直接修改图。
所有副作用由调用方（server.py 的 snap_parts 端点）决定如何处理。
"""

import logging
from typing import Any, Dict, List, Optional

import numpy as np

from backend.connection_edge import ConnectionEdge

logger = logging.getLogger(__name__)

# ── 阈值常量 ────────────────────────────────────────────────────────────────

# 两个 Site 中心点之间的最大欧氏距离 (世界坐标, SI 米)，
# 在此距离内认为它们在物理上"接触"，属于自动闭合候选。
# 选取 1mm：约为 LEGO 乐高 1LDU 的 2.5 倍，足以覆盖装配公差。
AUTO_LATCH_THRESHOLD_M: float = 0.001


# ── 端口键序列化（与前端 store.ts portKey() 严格对齐）──────────────────────────

def serialize_port_key(pos, rot=None) -> str:
    """
    把端口的本地位置 (+ 可选 Z 法线) 序列化为字符串 key，与前端 ``store.ts``
    的 ``portKey()`` 输出**逐字符一致**：``"x,y,z|nx,ny,nz"``，位置 4 位小数、
    法线 2 位小数。

    用于在 ``/api/snap_parts`` 响应中标识 AutoLatch 闭合的端口对，使前端能
    无歧义地索引到 ``occupiedPorts[partId][key]``。

    Args:
        pos: 端口本地坐标 (3,) — np.ndarray 或 list/tuple，单位 SI 米。
        rot: 可选；端口本地旋转矩阵 (3,3)。提供时会附加 Z 法线分量
             （矩阵第三列 = 端口出向轴）作为 key 后缀。

    Returns:
        字符串 key。

    备注:
        负零归一化 (``-0.0`` → ``0.0000``) 是必要的：JS ``(-0).toFixed(4)``
        返回 ``"0.0000"``，而 Python ``f"{-0.0:.4f}"`` 返回 ``"-0.0000"``。
        若不归一化会导致 backend↔frontend key 字符串不一致，前端写入
        ``occupiedPorts`` 后下游查询命中不上。
    """

    def _fmt4(v: float) -> str:
        rounded = round(float(v), 4)
        if rounded == 0.0:
            return "0.0000"
        return f"{rounded:.4f}"

    def _fmt2(v: float) -> str:
        rounded = round(float(v), 2)
        if rounded == 0.0:
            return "0.00"
        return f"{rounded:.2f}"

    pos_arr = np.asarray(pos, dtype=float).reshape(-1)
    base = f"{_fmt4(pos_arr[0])},{_fmt4(pos_arr[1])},{_fmt4(pos_arr[2])}"
    if rot is None:
        return base
    rot_arr = np.asarray(rot, dtype=float).reshape(3, 3)
    zx, zy, zz = rot_arr[0, 2], rot_arr[1, 2], rot_arr[2, 2]
    return f"{base}|{_fmt2(zx)},{_fmt2(zy)},{_fmt2(zz)}"


class AutoLatchScanner:
    """
    自动闭合扫描器。

    工作流程：
      1. 将每个 Site 的本地坐标通过所属零件的世界变换矩阵将其投影到世界坐标系。
      2. 对父 / 子零件所有 Site 对做笛卡尔积距离筛选。
      3. 对通过距离筛选的 Site 对，遍历端口对，验证语义是否兼容（male↔female, 同 profile）。
      4. 对通过语义筛选的 Site 对，构建 ConnectionEdge 并收集到待返回列表。
      5. 排除主连接端口对（由 snap_parts 已直接注册），保证幂等性。
    """

    def __init__(self, threshold_m: float = AUTO_LATCH_THRESHOLD_M) -> None:
        self._threshold = threshold_m
        logger.debug(
            f"[DEBUG] AutoLatchScanner 初始化: threshold={self._threshold*1000:.1f}mm"
        )

    # ── 公共接口 ─────────────────────────────────────────────────────────────

    def scan(
        self,
        parent_id: str,
        child_id: str,
        parent_sites: List[Dict[str, Any]],
        child_sites: List[Dict[str, Any]],
        parent_world_transform: np.ndarray,
        child_world_transform: np.ndarray,
        exclude_port_pair: Optional[tuple[str, str]] = None,
    ) -> List[ConnectionEdge]:
        """
        执行自动闭合扫描。

        Args:
            parent_id: 父零件实例 ID。
            child_id:  子零件实例 ID。
            parent_sites: 父零件的 Site 字典列表（来自 ldraw_port_configs.json）。
            child_sites:  子零件的 Site 字典列表。
            parent_world_transform: 父零件 4x4 世界变换矩阵 (SI, Y-Up)。
            child_world_transform:  子零件 4x4 世界变换矩阵。
            exclude_port_pair: 可选; (parent_port_name, child_port_name) 元组，
                               主连接点已注册，跳过以保证幂等性。

        Returns:
            新发现的 ConnectionEdge 列表（不含已排除的主连接点）。
        """
        logger.debug(
            f"[DEBUG] scan(): parent={parent_id}, child={child_id}, "
            f"n_parent_sites={len(parent_sites)}, n_child_sites={len(child_sites)}"
        )

        new_edges: List[ConnectionEdge] = []

        # 将所有 Site 中心点投影到世界坐标系
        parent_world_sites = self._project_sites(parent_sites, parent_world_transform)
        child_world_sites = self._project_sites(child_sites, child_world_transform)

        # 对所有 Site 对做距离 × 语义双筛选
        for p_site_data in parent_world_sites:
            for c_site_data in child_world_sites:
                dist = np.linalg.norm(
                    p_site_data["world_pos"] - c_site_data["world_pos"]
                )
                logger.debug(
                    f"[DEBUG] Site 对 ({p_site_data['id']} ↔ {c_site_data['id']}) "
                    f"距离={dist*1000:.3f}mm"
                )

                if dist > self._threshold:
                    # 距离超出阈值，跳过
                    continue

                # 在语义层寻找兼容端口对
                edge = self._find_compatible_edge(
                    parent_id=parent_id,
                    child_id=child_id,
                    parent_site=p_site_data["raw"],
                    child_site=c_site_data["raw"],
                    exclude_port_pair=exclude_port_pair,
                )
                if edge is not None:
                    new_edges.append(edge)
                    logger.info(
                        f"[AutoLatch] 发现新连接: {parent_id}[{p_site_data['id']}] "
                        f"↔ {child_id}[{c_site_data['id']}]"
                    )

        logger.debug(f"[DEBUG] scan() 完成: 发现 {len(new_edges)} 条新边。")
        return new_edges

    # ── 群组扫描（v4.1, PR #182 扩 scope）─────────────────────────────────────

    def scan_group_against_scene(
        self,
        group_members: List[Dict[str, Any]],
        static_parts: List[Dict[str, Any]],
        sites_loader,
        exclude_main_pair: Optional[tuple] = None,
    ) -> List[ConnectionEdge]:
        """
        扫「group_members 群组 × static_parts 静止件」的双笛卡尔积，
        对每对 (g, s) 调用 scan() 找新的 port 对扣边。

        典型用法：snap 把 source 群组刚体平移到 target 之后，组里其他件可能
        正好也落进其他静止件的孔 1mm 内 —— 老版 scan 只看 parent ↔ child，
        漏掉这些 → 前端补全 [FrontendLatch]。这里后端原生覆盖、前端可移除补全。

        Args:
            group_members: 群组内每件的快照 dict，含 'part_id' / 'world_transform'(4x4 ndarray)
            static_parts:  场景静止件快照，结构同上
            sites_loader:  callable(part_id, ldraw_id) -> List[Dict] (site 列表)
                           外部传入避免本模块依赖 port_lib_manager（保持纯函数易测）
            exclude_main_pair: 主 snap edge 的 (parent_id, child_id, port_p_name, port_c_name)，
                               对这一对 (parent, child) 跳过它们之间已注册的那一条 port pair

        Returns:
            所有新发现的 ConnectionEdge 去重列表
        """
        if not group_members or not static_parts:
            return []

        new_edges: List[ConnectionEdge] = []
        seen_pair_keys: set = set()  # 去重：同一 (part_a, port_a) ↔ (part_b, port_b) 多路命中

        for g in group_members:
            g_id = g.get("part_id")
            g_ldraw = g.get("ldraw_id")
            g_T = g.get("world_transform")
            # 类型守卫：必须有 part_id 且 sites/transform 完整才扫。
            # 同时窄化 mypy 类型 —— scan() 下游签名要 str，不能 Any | None。
            if not isinstance(g_id, str) or not isinstance(g_ldraw, str):
                continue
            g_sites = sites_loader(g_id, g_ldraw)
            if not g_sites or g_T is None:
                continue
            for s in static_parts:
                s_id = s.get("part_id")
                if not isinstance(s_id, str) or s_id == g_id:
                    continue
                s_ldraw = s.get("ldraw_id")
                if not isinstance(s_ldraw, str):
                    continue
                s_T = s.get("world_transform")
                s_sites = sites_loader(s_id, s_ldraw)
                if not s_sites or s_T is None:
                    continue

                # 主 snap 已注册的那一对 port 不重复登记
                exclude_pair = None
                if exclude_main_pair:
                    parent_id, child_id, port_p_name, port_c_name = exclude_main_pair
                    if {g_id, s_id} == {parent_id, child_id}:
                        exclude_pair = (port_p_name, port_c_name)

                edges = self.scan(
                    parent_id=g_id, child_id=s_id,
                    parent_sites=g_sites, child_sites=s_sites,
                    parent_world_transform=g_T, child_world_transform=s_T,
                    exclude_port_pair=exclude_pair,
                )
                for e in edges:
                    # 去重 key 用排序后的 (part, port) 二元组对，跨方向同对扣只收一次
                    a = (e.parent_id, getattr(e.port_parent, "name", "") or "")
                    b = (e.child_id, getattr(e.port_child, "name", "") or "")
                    pair_key = tuple(sorted([a, b]))
                    if pair_key in seen_pair_keys:
                        continue
                    seen_pair_keys.add(pair_key)
                    new_edges.append(e)

        logger.debug(
            f"[DEBUG] scan_group_against_scene() 完成: "
            f"group={len(group_members)} × static={len(static_parts)} -> {len(new_edges)} 条新边"
        )
        return new_edges

    # ── 私有方法 ─────────────────────────────────────────────────────────────

    def _project_sites(
        self,
        sites: List[Dict[str, Any]],
        world_transform: np.ndarray,
    ) -> List[Dict[str, Any]]:
        """
        将 Site 的本地坐标通过世界变换矩阵投影至世界坐标系。

        Args:
            sites: 原始 Site 字典列表（包含 'position' 字段，SI 米制）。
            world_transform: 零件的 4x4 世界变换矩阵。

        Returns:
            列表，每项含 'raw'（原始 dict）、'id'（site id）、'world_pos'（np.ndarray(3)）。
        """
        result = []
        for site in sites:
            local_pos = np.array(site.get("position", [0.0, 0.0, 0.0]), dtype=float)
            # 转为齐次坐标并应用变换
            local_h = np.array([local_pos[0], local_pos[1], local_pos[2], 1.0])
            world_pos = (world_transform @ local_h)[:3]
            result.append({
                "id": site.get("id", "unknown"),
                "raw": site,
                "world_pos": world_pos,
            })
            logger.debug(
                f"[DEBUG] Site '{site.get('id')}' 本地位置={local_pos.round(5).tolist()} "
                f"-> 世界位置={world_pos.round(5).tolist()}"
            )
        return result

    def _find_compatible_edge(
        self,
        parent_id: str,
        child_id: str,
        parent_site,
        child_site,
        exclude_port_pair,
    ):
        parent_ports_raw = parent_site.get("ports", [])
        child_ports_raw = child_site.get("ports", [])
        import numpy as _np
        from backend.port_semantics import FitType as _FitType, get_interface as _gi, check_fit as _cf
        from backend.port import Port as _Port
        from backend.connection_edge import ConnectionEdge as _CE

        for pp_raw in parent_ports_raw:
            pp_name = pp_raw.get("name", "")
            pp_type = pp_raw.get("type", "")
            pp_iface = _gi(pp_type)
            if pp_iface is None:
                continue

            for cp_raw in child_ports_raw:
                cp_name = cp_raw.get("name", "")
                cp_type = cp_raw.get("type", "")
                cp_iface = _gi(cp_type)
                if cp_iface is None:
                    continue

                if exclude_port_pair and (
                    (pp_name, cp_name) == exclude_port_pair
                    or (cp_name, pp_name) == exclude_port_pair
                ):
                    continue

                # Try both orderings because check_fit requires MALE as first arg
                fit_a = _cf(pp_iface, cp_iface)
                fit_b = _cf(cp_iface, pp_iface)

                if fit_a != _FitType.INCOMPATIBLE:
                    plug_raw, socket_raw = pp_raw, cp_raw
                    plug_id, socket_id = parent_id, child_id
                elif fit_b != _FitType.INCOMPATIBLE:
                    plug_raw, socket_raw = cp_raw, pp_raw
                    plug_id, socket_id = child_id, parent_id
                else:
                    continue

                plug_pos = _np.array(plug_raw.get("position", [0.0, 0.0, 0.0]), dtype=float)
                plug_rot = _np.array(plug_raw.get("rotation", [[1,0,0],[0,1,0],[0,0,1]]), dtype=float).reshape(3, 3)
                socket_pos = _np.array(socket_raw.get("position", [0.0, 0.0, 0.0]), dtype=float)
                socket_rot = _np.array(socket_raw.get("rotation", [[1,0,0],[0,1,0],[0,0,1]]), dtype=float).reshape(3, 3)

                port_plug   = _Port.from_raw(plug_raw["name"],   plug_raw["type"],   plug_pos,   plug_rot,   part_context=plug_id)
                port_socket = _Port.from_raw(socket_raw["name"], socket_raw["type"], socket_pos, socket_rot, part_context=socket_id)

                if port_plug is None or port_socket is None:
                    continue

                return _CE(
                    parent_id=plug_id,
                    child_id=socket_id,
                    port_parent=port_plug,
                    port_child=port_socket,
                )

        return None


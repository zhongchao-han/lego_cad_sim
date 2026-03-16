"""
assembly.py
===========
Assembly — 装配体，管理零件集合与零件间的连接关系。

设计依据 docs/assembly_hierarchy_design.md §2.3：
  引入 Assembly 概念承担系统级组装职责。
  它是多个 Part 及其 ConnectionEdge 的集合，遵循 Composite Pattern，
  Assembly 自身也可作为整体暴露对外接口（嵌套装配预留）。

核心层级：
  ConnectionInterface -> Port -> Part -> ConnectionEdge (含 JointState) -> Assembly
"""

import uuid
import logging
from typing import Dict, List, Optional

import networkx as nx

from part import Part
from connection_edge import ConnectionEdge

logger = logging.getLogger(__name__)


class Assembly:
    """
    代表一个装配体模块。

    管理内部的零件以及零件之间的连接关系。
    通过 resolve_kinematics() 提取无环生成树，供 URDF 导出使用。
    """

    def __init__(self, assembly_id: str):
        self.assembly_id = assembly_id
        self.parts:       Dict[str, Part]           = {}
        self.connections: List[ConnectionEdge]      = []

        # 运动学多重有向图：允许同一对零件之间有多条连接边（过约束检测）
        self._kinematic_graph: nx.MultiDiGraph = nx.MultiDiGraph()

        # 被打断的闭环边（供 URDF 导出生成 Gazebo 约束标签）
        self.closed_loops: List[ConnectionEdge] = []

    # ------------------------------------------------------------------ #
    # 零件管理
    # ------------------------------------------------------------------ #

    def add_part(self, part: Part) -> None:
        """将零件加入装配体。重复添加同 part_id 的零件会覆盖旧数据。"""
        self.parts[part.part_id] = part
        self._kinematic_graph.add_node(part.part_id, data=part)
        logger.info(f"[{self.assembly_id}] 添加零件: {part.part_id} ({part.name})")

    def get_part(self, part_id: str) -> Optional[Part]:
        """按 ID 取出零件；不存在则返回 None。"""
        return self.parts.get(part_id)

    # ------------------------------------------------------------------ #
    # 连接管理
    # ------------------------------------------------------------------ #

    def connect_ports(self, edge: ConnectionEdge) -> None:
        """
        建立装配体内部的物理连接，包含安全校验。

        Raises:
            ValueError: 端口所属零件不在本装配体中，或物理接口不兼容。
        """
        if edge.parent_id not in self.parts:
            raise ValueError(
                f"Parent part {edge.parent_id!r} is not in assembly {self.assembly_id!r}. "
                f"Call add_part() first."
            )
        if edge.child_id not in self.parts:
            raise ValueError(
                f"Child part {edge.child_id!r} is not in assembly {self.assembly_id!r}. "
                f"Call add_part() first."
            )
        if not edge.is_physically_compatible():
            raise ValueError(
                f"Physical constraints prevent this connection: "
                f"{edge.port_parent!r} ↔ {edge.port_child!r}"
            )

        self.connections.append(edge)
        self._kinematic_graph.add_edge(
            edge.parent_id, edge.child_id,
            key=uuid.uuid4().hex,
            data=edge,
        )
        logger.info(
            f"[{self.assembly_id}] 连接: {edge.parent_id} → {edge.child_id}"
        )

    def disconnect_parts(self, parent_id: str, child_id: str) -> int:
        """
        移除两零件之间的所有连接边。

        Returns:
            实际移除的边数量。
        """
        removed = [
            e for e in self.connections
            if e.parent_id == parent_id and e.child_id == child_id
        ]
        for e in removed:
            self.connections.remove(e)

        # 同步更新运动学图
        keys_to_remove = [
            (u, v, k)
            for u, v, k, d in self._kinematic_graph.edges(keys=True, data=True)
            if u == parent_id and v == child_id
        ]
        self._kinematic_graph.remove_edges_from(keys_to_remove)

        if removed:
            logger.info(
                f"[{self.assembly_id}] 断开连接: {parent_id} → {child_id} "
                f"（移除 {len(removed)} 条边）"
            )
        return len(removed)

    # ------------------------------------------------------------------ #
    # 运动学推导
    # ------------------------------------------------------------------ #

    def resolve_kinematics(self) -> nx.DiGraph:
        """
        从运动学多重有向图中提取无环生成树（Spanning Tree）。

        算法：
          1. 多重边 → 简单边：同一对零件间若有多条边，标记 is_merged=True（过约束→Fixed）
          2. BFS 解环：跳过已访问节点，将跳过的边存入 self.closed_loops

        Returns:
            无环有向图（DiGraph）；边 data 字段存放 ConnectionEdge。
        """
        self.closed_loops.clear()

        # ── 步骤 1：过约束合并 ────────────────────────────────────────────
        simple: nx.DiGraph = nx.DiGraph()
        for node_id, data in self._kinematic_graph.nodes(data=True):
            simple.add_node(node_id, **data)

        for u, v in set(self._kinematic_graph.edges()):
            edges_uv  = self._kinematic_graph.get_edge_data(u, v)
            edge_list = list(edges_uv.values())
            primary: ConnectionEdge = edge_list[0]['data']
            if len(edge_list) > 1:
                primary.is_merged = True
                logger.info(
                    f"[{self.assembly_id}] 过约束: {u} ↔ {v} 有 {len(edge_list)} 条边，"
                    f"合并为 Fixed Joint。"
                )
            if not simple.has_edge(u, v):
                simple.add_edge(u, v, data=primary)

        # ── 步骤 2：BFS 解环 ──────────────────────────────────────────────
        tree: nx.DiGraph = nx.DiGraph()
        visited: set = set()

        in_degrees = dict(simple.in_degree())
        if not in_degrees:
            return tree

        root_candidates = [n for n, d in in_degrees.items() if d == 0]
        root = root_candidates[0] if root_candidates else list(simple.nodes)[0]
        logger.info(f"[{self.assembly_id}] URDF 树根节点: {root}")

        queue = [root]
        while queue:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)

            if not tree.has_node(current):
                tree.add_node(current, data=simple.nodes[current].get('data'))

            for neighbor in simple.successors(current):
                edge_data = simple.get_edge_data(current, neighbor)['data']
                if neighbor not in visited:
                    tree.add_edge(current, neighbor, data=edge_data)
                    queue.append(neighbor)
                else:
                    self.closed_loops.append(edge_data)
                    logger.warning(
                        f"[{self.assembly_id}] 闭环打断: {current} → {neighbor}"
                    )

        return tree

    # ------------------------------------------------------------------ #
    # 序列化 / 调试
    # ------------------------------------------------------------------ #

    def summary(self) -> dict:
        """返回装配体的简要摘要字典。"""
        return {
            "assembly_id": self.assembly_id,
            "parts":       list(self.parts.keys()),
            "connections": len(self.connections),
        }

    def __repr__(self) -> str:
        return (
            f"Assembly({self.assembly_id!r}, "
            f"parts={len(self.parts)}, connections={len(self.connections)})"
        )


# ---------------------------------------------------------------------------
# 自测
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=== assembly.py 自测 ===\n")

    import numpy as np
    from port import Port
    from connection_interface import LDU

    def mk_port(name, ldraw_type, pos=(0, 0, 0)):
        return Port.from_ldraw_or_fallback(name, ldraw_type, np.array(pos, dtype=float), np.eye(3))

    asm = Assembly("test_asm")

    # 构建零件
    beam_a = Part("A", "beam_3x1")
    beam_a.add_port(mk_port("h0", "peghole", [0.0, 0.0, 0.0]))

    beam_b = Part("B", "beam_3x1")
    beam_b.add_port(mk_port("h0", "peghole", [0.0, 0.0, 0.0]))

    pin_c = Part("C", "pin")
    pin_c.add_port(mk_port("p0", "pin", [0.0, 0.0, 0.0]))
    pin_c.add_port(mk_port("p1", "pin", [0.0, 0.016, 0.0]))

    asm.add_part(beam_a)
    asm.add_part(beam_b)
    asm.add_part(pin_c)

    # 连接
    e1 = ConnectionEdge("C", "A",
                        mk_port("p0", "pin", [0.0, 0.0, 0.0]),
                        mk_port("h0", "peghole", [0.0, 0.0, 0.0]))
    e2 = ConnectionEdge("C", "B",
                        mk_port("p1", "pin", [0.0, 0.016, 0.0]),
                        mk_port("h0", "peghole", [0.0, 0.0, 0.0]))

    asm.connect_ports(e1)
    asm.connect_ports(e2)

    assert len(asm.connections) == 2
    print(f"[连接数] {len(asm.connections)} OK")

    # 生成树
    tree = asm.resolve_kinematics()
    assert tree.number_of_nodes() == 3
    assert tree.number_of_edges() == 2
    print(f"[生成树] 节点={tree.number_of_nodes()}, 边={tree.number_of_edges()} OK")

    # 不在装配体中的零件 → ValueError
    ghost = Part("GHOST", "ghost")
    try:
        bad_edge = ConnectionEdge("GHOST", "A",
                                  mk_port("p", "pin"),
                                  mk_port("h", "peghole"))
        asm.connect_ports(bad_edge)
        assert False, "应抛出 ValueError"
    except ValueError:
        print("[ValueError] 未注册零件的连接被拒绝 OK")

    # 断开连接
    removed = asm.disconnect_parts("C", "A")
    assert removed == 1
    assert len(asm.connections) == 1
    print(f"[断开连接] removed={removed} OK")

    print(f"\n{asm!r}")
    print("\n[所有断言通过 OK]")

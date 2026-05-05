"""
test_statics_solver.py — L51b PR-B ① 反力求解
=============================================
覆盖：
  - 空图 / 单零件 / 链式吊挂 / 闭环
  - 已知力学问题的解析答案对照（cantilever 重物）
  - 求解器对超定 / 欠定系统的鲁棒性
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.connection_edge import ConnectionEdge  # noqa: E402
from backend.port import Port  # noqa: E402
from backend.statics_solver import GRAVITY_M_S2, solve_reactions  # noqa: E402
from backend.topology_manager import PartNode, TopologyManager  # noqa: E402


def _mk_port(name: str, ldraw_type: str, pos) -> Port:
    port = Port.from_raw(
        name, ldraw_type, np.array(pos, dtype=float), np.eye(3),
        part_context="X",
    )
    if port is None:
        raise RuntimeError(f"无法创建 Port: {ldraw_type}")
    return port


def _mk_part(part_id: str, world_pos=(0.0, 0.0, 0.0)) -> PartNode:
    node = PartNode(part_id=part_id, name=part_id)
    T = np.eye(4)
    T[:3, 3] = np.array(world_pos)
    node.global_transform = T
    return node


class TestStaticsSolverBasic(unittest.TestCase):
    """基础边界 case + 简单解析对照。"""

    def test_empty_graph_returns_empty_dict(self):
        tm = TopologyManager()
        self.assertEqual(solve_reactions(tm), {})

    def test_single_part_no_edges_returns_empty(self):
        """单零件无 edge → 全靠 ground anchor 平衡，没 edge wrench 输出。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("A", world_pos=(0, 0, 0)))
        out = solve_reactions(tm)
        self.assertEqual(out, {})

    def test_two_parts_one_fixed_joint_grounded(self):
        """A 在地面 (Y=0)，B 在 A 上方 (Y=1m)，1 条 fixed edge 把 B 挂在 A 上。
        edge wrench 必须托住 B 的重力 m_B·g。"""
        tm = TopologyManager()
        m_b = 0.001  # 默认 mass
        tm.add_part(_mk_part("A", world_pos=(0, 0, 0)))
        tm.add_part(_mk_part("B", world_pos=(0, 1.0, 0)))
        # parent=A, child=B；joint anchor 取在 A 顶上 (port_parent.position 局部 (0,1,0) 映到世界 (0,1,0))
        tm.connect_ports(ConnectionEdge(
            "A", "B",
            _mk_port("p", "peghole", [0, 1.0, 0]),
            _mk_port("c", "pin",     [0, 0, 0]),
        ))
        out = solve_reactions(tm)
        self.assertEqual(len(out), 1)
        edge = next(iter(out.values()))
        # B 由这条 edge 挂着，edge force 在 B 上 = +F；B 的 force 平衡：
        # +F + (0, -m_b·g, 0) = 0  →  F_y = +m_b·g
        expected_fy = m_b * GRAVITY_M_S2
        self.assertAlmostEqual(edge['force'][1], expected_fy, places=4)
        # F_x, F_z 应 ≈ 0（无横向载荷）
        self.assertAlmostEqual(edge['force'][0], 0, places=4)
        self.assertAlmostEqual(edge['force'][2], 0, places=4)

    def test_chain_three_parts_force_increases_toward_root(self):
        """A (Y=0 grounded) → B (Y=1) → C (Y=2)，纯重力。
        B↔C edge 只挂 C；A↔B edge 要挂 B+C 的重量 → 力大一倍。"""
        tm = TopologyManager()
        for pid, y in [("A", 0.0), ("B", 1.0), ("C", 2.0)]:
            tm.add_part(_mk_part(pid, world_pos=(0, y, 0)))
        tm.connect_ports(ConnectionEdge(
            "A", "B", _mk_port("p", "peghole", [0, 1.0, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "B", "C", _mk_port("p", "peghole", [0, 1.0, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        out = solve_reactions(tm)
        self.assertEqual(len(out), 2)

        edges_by_pair = {(e['parent_id'], e['child_id']): e for e in out.values()}
        edge_AB = edges_by_pair[("A", "B")]
        edge_BC = edges_by_pair[("B", "C")]

        # B↔C edge 只挂 C
        m_c = 0.001
        self.assertAlmostEqual(edge_BC['force'][1], m_c * GRAVITY_M_S2, places=4)

        # A↔B edge 挂 B+C 的总重量
        m_b_plus_c = 0.001 + 0.001
        self.assertAlmostEqual(edge_AB['force'][1], m_b_plus_c * GRAVITY_M_S2, places=4)

    def test_mass_provider_callback_used(self):
        """自定义 mass_provider 回调被尊重。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("A", world_pos=(0, 0, 0)))
        tm.add_part(_mk_part("B", world_pos=(0, 1.0, 0)))
        tm.connect_ports(ConnectionEdge(
            "A", "B", _mk_port("p", "peghole", [0, 1.0, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        # mass_provider 让 B = 5 kg
        out = solve_reactions(
            tm,
            mass_provider=lambda pid, ldraw_id: 5.0 if pid == "B" else 0.001,
        )
        edge = next(iter(out.values()))
        self.assertAlmostEqual(edge['force'][1], 5.0 * GRAVITY_M_S2, places=4)


class TestStaticsSolverClosedLoop(unittest.TestCase):
    """闭环 → 系统欠定 → lstsq 给最小范数解。要求至少不崩、各 edge 受力合理。"""

    def test_triangle_loop_solver_does_not_crash(self):
        """3 part 三角形闭环，求解器应稳定返回 3 条 edge wrench。"""
        tm = TopologyManager()
        for pid, pos in [("A", (0, 0, 0)), ("B", (1, 0, 0)), ("C", (0.5, 1, 0))]:
            tm.add_part(_mk_part(pid, world_pos=pos))
        tm.connect_ports(ConnectionEdge(
            "A", "B", _mk_port("p", "peghole", [1, 0, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "B", "C", _mk_port("p", "peghole", [-0.5, 1, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "C", "A", _mk_port("p", "peghole", [-0.5, -1, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        out = solve_reactions(tm)
        self.assertEqual(len(out), 3)
        # 每条都有 6D wrench，magnitude 是非负有限数
        for e in out.values():
            self.assertEqual(len(e['force']), 3)
            self.assertEqual(len(e['torque']), 3)
            self.assertTrue(np.isfinite(e['magnitude_force']))
            self.assertTrue(np.isfinite(e['magnitude_torque']))


class TestStaticsSolverDataShape(unittest.TestCase):
    """返回数据 shape 正确，便于前端消费。"""

    def test_output_keys_and_value_types(self):
        tm = TopologyManager()
        tm.add_part(_mk_part("A", world_pos=(0, 0, 0)))
        tm.add_part(_mk_part("B", world_pos=(0, 0.5, 0)))
        tm.connect_ports(ConnectionEdge(
            "A", "B", _mk_port("p", "peghole", [0, 0.5, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        out = solve_reactions(tm)
        self.assertEqual(len(out), 1)
        edge = next(iter(out.values()))
        # 必备字段
        for key in ('parent_id', 'child_id', 'anchor_world', 'force',
                    'torque', 'magnitude_force', 'magnitude_torque'):
            self.assertIn(key, edge)
        # anchor_world / force / torque 都是 3-元素 list of float
        for vec_key in ('anchor_world', 'force', 'torque'):
            self.assertEqual(len(edge[vec_key]), 3)
            self.assertTrue(all(isinstance(x, float) for x in edge[vec_key]))


if __name__ == "__main__":
    unittest.main()

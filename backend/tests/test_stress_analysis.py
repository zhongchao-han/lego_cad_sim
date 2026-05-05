"""
test_stress_analysis.py — L51b PR-C 真应力近似
================================================
覆盖：
  - 纯轴向拉力：σ = F/A，τ = 0，σ_vm = σ
  - 纯横向剪力：σ = 0，τ = F/A，σ_vm = √3·τ
  - 屈服阈值边界：σ_vm < ABS_YIELD → safety < 1，反之 yields=True
  - 非 CYLINDER 截面（CROSS / STUD）→ None
  - 接口缺失 / 旋转矩阵异常 → None 不抛错
  - enrich_reactions_with_stress：批量补 stress 字段
"""
from __future__ import annotations

import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.connection_edge import ConnectionEdge  # noqa: E402
from backend.port import Port  # noqa: E402
from backend.statics_solver import solve_reactions  # noqa: E402
from backend.stress_analysis import (  # noqa: E402
    ABS_YIELD_PA,
    SAFETY_FAILED,
    analyze_edge_stress,
    enrich_reactions_with_stress,
)
from backend.topology_manager import PartNode, TopologyManager  # noqa: E402


def _mk_port(name, ldraw_type, pos, rot=None) -> Port:
    rotation = np.eye(3) if rot is None else np.asarray(rot, dtype=float)
    port = Port.from_raw(name, ldraw_type, np.array(pos, dtype=float), rotation, part_context="X")
    if port is None:
        raise RuntimeError(f"无法创建 Port: {ldraw_type}")
    return port


def _mk_part(part_id, world_pos=(0.0, 0.0, 0.0)) -> PartNode:
    node = PartNode(part_id=part_id, name=part_id)
    T = np.eye(4)
    T[:3, 3] = np.array(world_pos)
    node.global_transform = T
    return node


def _pin_peghole_edge(force_world=(0.0, 0.0, 0.0)):
    """夹具：父端口 = peghole（CYLINDER FEMALE，半径 6 LDU = 2.4mm）。
    返回 (edge, parent_world_T)；force 由 caller 投。"""
    edge = ConnectionEdge(
        "A", "B",
        _mk_port("p", "peghole", [0, 0, 0]),
        _mk_port("c", "pin", [0, 0, 0]),
    )
    return edge, np.eye(4)


class TestAnalyzeEdgeStress(unittest.TestCase):

    def test_pure_axial_pull(self):
        """1000 N 沿 +Z 拉 → σ = F/A，τ = 0，σ_vm = σ。"""
        edge, T = _pin_peghole_edge()
        # peghole 半径 6.0 LDU = 6 × 0.0004 m = 0.0024 m
        r = 6.0 * 0.0004
        A = math.pi * r * r
        result = analyze_edge_stress(edge, T, np.array([0, 0, 1000.0]))
        self.assertIsNotNone(result)
        assert result is not None  # mypy
        self.assertAlmostEqual(result['axial_force_N'], 1000.0, places=4)
        self.assertAlmostEqual(result['shear_force_N'], 0.0, places=4)
        self.assertAlmostEqual(result['normal_stress_pa'], 1000.0 / A, places=2)
        self.assertAlmostEqual(result['shear_stress_pa'], 0.0, places=2)
        self.assertAlmostEqual(result['von_mises_pa'], 1000.0 / A, places=2)

    def test_pure_axial_compression(self):
        """-1000 N 沿 +Z（压）→ σ = |F|/A（仍正），σ_vm = σ。"""
        edge, T = _pin_peghole_edge()
        r = 6.0 * 0.0004
        A = math.pi * r * r
        result = analyze_edge_stress(edge, T, np.array([0, 0, -1000.0]))
        assert result is not None
        self.assertAlmostEqual(result['axial_force_N'], -1000.0, places=4)
        self.assertAlmostEqual(result['normal_stress_pa'], 1000.0 / A, places=2)

    def test_pure_lateral_shear(self):
        """1000 N 沿 +X（垂直 Z 轴）→ σ = 0，τ = F/A，σ_vm = √3·τ。"""
        edge, T = _pin_peghole_edge()
        r = 6.0 * 0.0004
        A = math.pi * r * r
        result = analyze_edge_stress(edge, T, np.array([1000.0, 0, 0]))
        assert result is not None
        self.assertAlmostEqual(result['axial_force_N'], 0.0, places=4)
        self.assertAlmostEqual(result['shear_force_N'], 1000.0, places=4)
        self.assertAlmostEqual(result['shear_stress_pa'], 1000.0 / A, places=2)
        self.assertAlmostEqual(result['von_mises_pa'], math.sqrt(3.0) * 1000.0 / A, places=2)

    def test_combined_axial_and_shear(self):
        """3-4-5 三角分解：F = (4, 0, 3) → axial=3, shear=4。"""
        edge, T = _pin_peghole_edge()
        r = 6.0 * 0.0004
        A = math.pi * r * r
        result = analyze_edge_stress(edge, T, np.array([4.0, 0, 3.0]))
        assert result is not None
        self.assertAlmostEqual(result['axial_force_N'], 3.0, places=4)
        self.assertAlmostEqual(result['shear_force_N'], 4.0, places=4)
        sigma = 3.0 / A
        tau = 4.0 / A
        self.assertAlmostEqual(result['von_mises_pa'], math.sqrt(sigma * sigma + 3.0 * tau * tau), places=2)

    def test_rotated_parent_axial_axis_follows_R(self):
        """父零件世界变换有旋转时，axial direction 跟着转。"""
        edge, T = _pin_peghole_edge()
        # 父零件绕 Y 轴 +90°：局部 +Z → 世界 +X
        T = np.eye(4)
        T[:3, :3] = np.array([
            [0, 0, 1],
            [0, 1, 0],
            [-1, 0, 0],
        ])
        # 沿世界 +X 拉力 1000 N 应被识别为 axial（因为局部 Z 现在指向世界 X）
        result = analyze_edge_stress(edge, T, np.array([1000.0, 0, 0]))
        assert result is not None
        self.assertAlmostEqual(result['axial_force_N'], 1000.0, places=4)
        self.assertAlmostEqual(result['shear_force_N'], 0.0, places=3)

    def test_yield_threshold(self):
        """计算让 σ_vm 刚好等于 ABS_YIELD 的力 → safety_ratio = 1.0、yields=True。"""
        edge, T = _pin_peghole_edge()
        r = 6.0 * 0.0004
        A = math.pi * r * r
        F_critical = ABS_YIELD_PA * A  # σ = F/A = yield → F = yield · A
        result = analyze_edge_stress(edge, T, np.array([0, 0, F_critical]))
        assert result is not None
        self.assertAlmostEqual(result['safety_ratio'], 1.0, places=4)
        self.assertTrue(result['yields'])

        # 略低于阈值 → 不屈服
        result2 = analyze_edge_stress(edge, T, np.array([0, 0, F_critical * 0.9]))
        assert result2 is not None
        self.assertLess(result2['safety_ratio'], SAFETY_FAILED)
        self.assertFalse(result2['yields'])

    def test_cross_profile_returns_none(self):
        """轴 / 轴孔（CROSS profile）截面是十字，σ_vm 公式不适用 → None。"""
        edge = ConnectionEdge(
            "A", "B",
            _mk_port("p", "axle", [0, 0, 0]),       # MALE CROSS
            _mk_port("c", "axlehole", [0, 0, 0]),   # FEMALE CROSS
        )
        # 注意：edge.port_parent 是 axle（CROSS），所以走 None 路径
        self.assertIsNone(analyze_edge_stress(edge, np.eye(4), np.array([100, 0, 0])))

    def test_zero_force_returns_zero_stress(self):
        edge, T = _pin_peghole_edge()
        result = analyze_edge_stress(edge, T, np.array([0, 0, 0]))
        assert result is not None
        self.assertAlmostEqual(result['von_mises_pa'], 0.0, places=4)
        self.assertAlmostEqual(result['safety_ratio'], 0.0, places=4)

    def test_malformed_rotation_returns_none(self):
        """父零件 world_T 的旋转矩阵让局部 Z 投到零向量（不可能但防御性测试）。"""
        edge, T = _pin_peghole_edge()
        # 把 R 设全 0：axial_world 也全 0，无法 normalize
        T = T.copy()
        T[:3, :3] = np.zeros((3, 3))
        self.assertIsNone(analyze_edge_stress(edge, T, np.array([1000, 0, 0])))


class TestEnrichReactionsWithStress(unittest.TestCase):
    """端到端：solver + enrich 协同。"""

    def test_enrich_adds_stress_field_for_cylinder_edge(self):
        tm = TopologyManager()
        tm.add_part(_mk_part("A", world_pos=(0, 0, 0)))
        tm.add_part(_mk_part("B", world_pos=(0, 1.0, 0)))
        tm.connect_ports(ConnectionEdge(
            "A", "B",
            _mk_port("p", "peghole", [0, 1.0, 0]),
            _mk_port("c", "pin", [0, 0, 0]),
        ))
        reactions = solve_reactions(tm)
        enrich_reactions_with_stress(reactions, tm)
        self.assertEqual(len(reactions), 1)
        edge = next(iter(reactions.values()))
        self.assertIn('stress', edge)
        self.assertIsNotNone(edge['stress'])
        self.assertIn('safety_ratio', edge['stress'])
        # 重力很小 → safety 远小于 1
        self.assertLess(edge['stress']['safety_ratio'], 0.01)

    def test_enrich_returns_none_for_cross_edge(self):
        """edge 是 axle ↔ axlehole（CROSS）→ stress 应为 None。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("A", world_pos=(0, 0, 0)))
        tm.add_part(_mk_part("B", world_pos=(0, 1.0, 0)))
        tm.connect_ports(ConnectionEdge(
            "A", "B",
            _mk_port("p", "axle", [0, 1.0, 0]),
            _mk_port("c", "axlehole", [0, 0, 0]),
        ))
        reactions = solve_reactions(tm)
        enrich_reactions_with_stress(reactions, tm)
        if reactions:
            edge = next(iter(reactions.values()))
            self.assertIsNone(edge['stress'])


if __name__ == "__main__":
    unittest.main()

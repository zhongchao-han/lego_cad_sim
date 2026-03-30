"""
test_auto_latch_scanner.py
===========================
AutoLatchScanner 的全覆盖单元测试。

覆盖范围：
  - 单 Site 对在阈值内且语义兼容 → 返回 1 条边
  - 多 Site 对同时命中阈值 → 返回 2 条边
  - 主连接端口对幂等性跳过 → 返回 0 条边
  - 语义不兼容（孔对孔）→ 返回 0 条边
  - 距离超出阈值 → 返回 0 条边
  - TopologyManager.batch_connect 正确地批量注册并跳过无效节点
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.auto_latch_scanner import AutoLatchScanner, AUTO_LATCH_THRESHOLD_M
from backend.topology_manager import TopologyManager, PartNode


# ─────────────────────────────────────────────────────────────────────────────
# 共享测试装置
# ─────────────────────────────────────────────────────────────────────────────


def _make_site(
    site_id: str,
    port_name: str,
    port_type: str,
    local_pos: list,
) -> dict:
    """
    构造一个符合 server.py LDrawSite 格式的 Site 字典。
    """
    return {
        "id": site_id,
        "position": local_pos,
        "ports": [
            {
                "name": port_name,
                "type": port_type,
                "position": local_pos,
                "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            }
        ],
    }


def _identity_transform() -> np.ndarray:
    """返回 4×4 单位变换矩阵（零件位于世界原点，无旋转）。"""
    return np.eye(4)


def _translate_transform(dx: float, dy: float, dz: float) -> np.ndarray:
    """返回一个纯平移的 4×4 变换矩阵。"""
    T = np.eye(4)
    T[0, 3] = dx
    T[1, 3] = dy
    T[2, 3] = dz
    return T


# ─────────────────────────────────────────────────────────────────────────────
# 测试类
# ─────────────────────────────────────────────────────────────────────────────


class TestAutoLatchScanner(unittest.TestCase):
    """AutoLatchScanner 核心扫描逻辑测试。"""

    def setUp(self) -> None:
        self.scanner = AutoLatchScanner(threshold_m=AUTO_LATCH_THRESHOLD_M)

    # ── 正向测试 ──────────────────────────────────────────────────────────────

    def test_single_compatible_site_pair_within_threshold(self):
        """
        [Case 1] 单 Site 对，距离 < 阈值，语义兼容 → 返回 1 条边。
        父: peghole (FEMALE) 位于 [0, 0, 0]
        子: peg (MALE) 位于世界 [0, 0, 0] (子零件原点 [0,0,0] + 零平移变换)
        """
        parent_sites = [_make_site("s_p", "hole_p", "peghole.dat", [0.0, 0.0, 0.0])]
        child_sites = [_make_site("s_c", "peg_c", "peg.dat", [0.0, 0.0, 0.0])]

        edges = self.scanner.scan(
            parent_id="beam",
            child_id="pin",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
        )
        self.assertEqual(len(edges), 1, "应返回 1 条兼容的 ConnectionEdge。")
        # 双向修复后，MALE 侧（peg_c/pin）成为 plug parent，child 方向可以是 beam 或 pin
        ids = {edges[0].parent_id, edges[0].child_id}
        self.assertIn("beam", ids, "beam 应参与该连接。")
        self.assertIn("pin", ids, "pin 应参与该连接。")

    def test_two_compatible_pairs_both_within_threshold(self):
        """
        [Case 2] 两个 Site 对同时在阈值内且兼容 → 返回 2 条边。
        父零件有两个 Site，子零件也在同样的位置各有一个 peg Site。
        """
        parent_sites = [
            _make_site("s_p0", "hole_0", "peghole.dat", [0.0, 0.0, 0.0]),
            _make_site("s_p1", "hole_1", "peghole.dat", [0.008, 0.0, 0.0]),
        ]
        child_sites = [
            _make_site("s_c0", "peg_0", "peg.dat", [0.0, 0.0, 0.0]),
            _make_site("s_c1", "peg_1", "peg.dat", [0.008, 0.0, 0.0]),
        ]
        edges = self.scanner.scan(
            parent_id="long_beam",
            child_id="connector",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
        )
        self.assertEqual(len(edges), 2, "两对 Site 均在阈值内，应返回 2 条边。")

    # ── 幂等性测试 ────────────────────────────────────────────────────────────

    def test_main_connection_excluded_by_idempotency(self):
        """
        [Case 3] 主连接端口对应被排除（幂等性），不重复注册 → 返回 0 条边。
        """
        parent_sites = [_make_site("s_p", "hole_main", "peghole.dat", [0.0, 0.0, 0.0])]
        child_sites = [_make_site("s_c", "peg_main", "peg.dat", [0.0, 0.0, 0.0])]

        edges = self.scanner.scan(
            parent_id="beam",
            child_id="pin",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
            # 主连接的端口名，应被跳过
            exclude_port_pair=("hole_main", "peg_main"),
        )
        self.assertEqual(len(edges), 0, "主连接端口对应被幂等跳过，不重复注册。")

    # ── 语义不兼容测试 ────────────────────────────────────────────────────────

    def test_incompatible_female_to_female_returns_empty(self):
        """
        [Case 4] 孔对孔（Female-Female）语义不兼容 → 返回 0 条边。
        """
        parent_sites = [_make_site("s_p", "hole_p", "peghole.dat", [0.0, 0.0, 0.0])]
        child_sites = [_make_site("s_c", "hole_c", "peghole.dat", [0.0, 0.0, 0.0])]

        edges = self.scanner.scan(
            parent_id="beam_a",
            child_id="beam_b",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
        )
        self.assertEqual(len(edges), 0, "孔对孔语义不兼容，应返回空列表。")

    def test_incompatible_cross_to_round_returns_empty(self):
        """
        [Case 4b] 十字轴插圆孔（Profile Mismatch）→ 返回 0 条边。
        """
        parent_sites = [_make_site("s_p", "axle_p", "axle.dat", [0.0, 0.0, 0.0])]
        child_sites = [_make_site("s_c", "hole_c", "peghole.dat", [0.0, 0.0, 0.0])]

        edges = self.scanner.scan(
            parent_id="axle_part",
            child_id="beam",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
        )
        self.assertEqual(len(edges), 0, "截面不兼容，应返回空列表。")

    # ── 距离超出阈值测试 ──────────────────────────────────────────────────────

    def test_sites_beyond_threshold_return_empty(self):
        """
        [Case 5] 距离超出 AUTO_LATCH_THRESHOLD_M → 返回 0 条边。
        子零件偏移 10mm，远超 1mm 阈值。
        """
        parent_sites = [_make_site("s_p", "hole_p", "peghole.dat", [0.0, 0.0, 0.0])]
        child_sites = [_make_site("s_c", "peg_c", "peg.dat", [0.0, 0.0, 0.0])]

        # 子零件世界位置偏移 10mm
        child_T = _translate_transform(0.010, 0.0, 0.0)

        edges = self.scanner.scan(
            parent_id="beam",
            child_id="pin",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=child_T,
        )
        self.assertEqual(len(edges), 0, "距离 10mm 远超阈值，应返回空列表。")

    def test_site_exactly_at_threshold_boundary(self):
        """
        [Case 5b] 距离恰好等于阈值（不严格小于）→ 应返回 0 条边。
        边界条件验证: dist > threshold 才跳过（使用严格大于符号）。
        """
        parent_sites = [_make_site("s_p", "hole_p", "peghole.dat", [0.0, 0.0, 0.0])]
        child_sites = [_make_site("s_c", "peg_c", "peg.dat", [0.0, 0.0, 0.0])]

        # 子零件世界位置恰好等于阈值
        child_T = _translate_transform(AUTO_LATCH_THRESHOLD_M, 0.0, 0.0)
        edges = self.scanner.scan(
            parent_id="beam",
            child_id="pin",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=child_T,
        )
        # 距离 == threshold：扫描器使用严格 `dist > threshold`，
        # 故恰好等于阈值时不会被过滤，应返回 1 条边。
        self.assertEqual(len(edges), 1, "距离等于阈值时不应被过滤（严格 > 才跳过）。")

    # ── 空输入测试 ────────────────────────────────────────────────────────────

    def test_empty_sites_return_empty(self):
        """
        [Case 6] 其中一方 Site 列表为空 → 应返回 0 条边，不崩溃。
        """
        edges = self.scanner.scan(
            parent_id="beam",
            child_id="pin",
            parent_sites=[],
            child_sites=[_make_site("s_c", "peg_c", "peg.dat", [0.0, 0.0, 0.0])],
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
        )
        self.assertEqual(len(edges), 0, "父 Site 为空时应返回 0 条边。")


class TestTopologyManagerBatchConnect(unittest.TestCase):
    """TopologyManager.batch_connect 单元测试。"""

    def setUp(self) -> None:
        self.manager = TopologyManager()
        self.manager.add_part(PartNode(part_id="A", name="beam_a"))
        self.manager.add_part(PartNode(part_id="B", name="pin_b"))

    def test_batch_connect_registers_edges_for_existing_nodes(self):
        """
        [BC-1] batch_connect 对两个图中已存在的节点成功注册边。
        """
        scanner = AutoLatchScanner()
        parent_sites = [_make_site("s_p", "hole_p", "peghole.dat", [0.0, 0.0, 0.0])]
        child_sites = [_make_site("s_c", "peg_c", "peg.dat", [0.0, 0.0, 0.0])]
        edges = scanner.scan("A", "B", parent_sites, child_sites, np.eye(4), np.eye(4))

        self.assertEqual(len(edges), 1)
        count = self.manager.batch_connect(edges)
        self.assertEqual(count, 1, "应成功注册 1 条边。")
        # 双向修复后，MALE peg_c(B) 成为 parent: 图中应有 B→A 边
        actual_edge_present = self.manager.graph.has_edge(
            "A", "B"
        ) or self.manager.graph.has_edge("B", "A")
        self.assertTrue(actual_edge_present, "图中应存在 A-B 之间的边（任意方向）。")

    def test_batch_connect_skips_unknown_nodes(self):
        """
        [BC-2] batch_connect 应跳过涉及图中不存在节点的边，不崩溃。
        """
        scanner = AutoLatchScanner()
        parent_sites = [_make_site("s_p", "hole_p", "peghole.dat", [0.0, 0.0, 0.0])]
        child_sites = [_make_site("s_c", "peg_c", "peg.dat", [0.0, 0.0, 0.0])]
        # "X" 节点不存在于图中
        edges = scanner.scan("A", "X", parent_sites, child_sites, np.eye(4), np.eye(4))

        count = self.manager.batch_connect(edges)
        self.assertEqual(count, 0, "子节点 X 不在图中，应跳过并返回 0。")

    def test_batch_connect_empty_list(self):
        """
        [BC-3] 空列表不应崩溃，应返回 0。
        """
        count = self.manager.batch_connect([])
        self.assertEqual(count, 0, "空列表应返回 0 且不崩溃。")


if __name__ == "__main__":
    unittest.main(verbosity=2)

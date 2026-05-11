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

from backend.auto_latch_scanner import (
    AutoLatchScanner,
    AUTO_LATCH_THRESHOLD_M,
    serialize_port_key,
)
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
        child_sites  = [_make_site("s_c", "peg_c",  "peg.dat",     [0.0, 0.0, 0.0])]

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
        self.assertIn("pin",  ids, "pin 应参与该连接。")

    def test_two_compatible_pairs_both_within_threshold(self):
        """
        [Case 2] 两个 Site 对同时在阈值内且兼容 → 返回 2 条边。
        父零件有两个 Site，子零件也在同样的位置各有一个 peg Site。
        """
        parent_sites = [
            _make_site("s_p0", "hole_0", "peghole.dat", [0.0,  0.0, 0.0]),
            _make_site("s_p1", "hole_1", "peghole.dat", [0.008, 0.0, 0.0]),
        ]
        child_sites = [
            _make_site("s_c0", "peg_0", "peg.dat", [0.0,  0.0, 0.0]),
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
        child_sites  = [_make_site("s_c", "peg_main",  "peg.dat",     [0.0, 0.0, 0.0])]

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
        child_sites  = [_make_site("s_c", "hole_c", "peghole.dat", [0.0, 0.0, 0.0])]

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
        child_sites  = [_make_site("s_c", "hole_c", "peghole.dat", [0.0, 0.0, 0.0])]

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
        child_sites  = [_make_site("s_c", "peg_c",  "peg.dat",     [0.0, 0.0, 0.0])]

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
        child_sites  = [_make_site("s_c", "peg_c",  "peg.dat",     [0.0, 0.0, 0.0])]

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


class TestAutoLatchPlugScenarios(unittest.TestCase):
    """走法 A 期 B.3-2 — plug-snap 整片闭合集成验证。

    现有 case 1/2 已覆盖 1/2 Site 对；本类加 plug 级密度（8 / 4 / 双面）的
    场景，跟前端 predictPlugSnapPairs（B.3-1）做配对计数对照：

      - 8↔8 plate-on-plate（2x4 plate stud↔tube 全连）
      - 8↔4 asymmetric（2x4 plate 部分覆盖 1x4 plate）
      - 主连接幂等 + plug 整片 → main 边 + plug-1 个 auto-latched
    """

    def setUp(self) -> None:
        self.scanner = AutoLatchScanner(threshold_m=AUTO_LATCH_THRESHOLD_M)

    @staticmethod
    def _2x4_grid_sites(prefix: str, port_name_prefix: str, port_type: str) -> list:
        """生成 2x4 网格 (8 stud/tube)：x ∈ {0, 0.008}, z ∈ {0..0.024:0.008}."""
        sites = []
        idx = 0
        for x in range(2):
            for z in range(4):
                sites.append(_make_site(
                    f"{prefix}_s{idx}",
                    f"{port_name_prefix}_{idx}",
                    port_type,
                    [x * 0.008, 0.0, z * 0.008],
                ))
                idx += 1
        return sites

    @staticmethod
    def _1x4_grid_sites(prefix: str, port_name_prefix: str, port_type: str) -> list:
        """生成 1x4 网格 (4 stud/tube)：x = 0, z ∈ {0..0.024:0.008}."""
        sites = []
        for z in range(4):
            sites.append(_make_site(
                f"{prefix}_s{z}",
                f"{port_name_prefix}_{z}",
                port_type,
                [0.0, 0.0, z * 0.008],
            ))
        return sites

    def test_8_stud_to_8_tube_full_plate_snap(self):
        """[Case P1] 2x4 plate 顶 stud (8 MALE) ↔ 2x4 plate 底 tube (8 FEMALE)
        完美对齐 → Auto-Latch 应返 8 条边（无 main connection exclusion）。

        跟前端 predictPlugSnapPairs 在同几何输入下应返 8 对一致。
        """
        parent_sites = self._2x4_grid_sites("p", "stud", "stud.dat")  # MALE
        child_sites = self._2x4_grid_sites("c", "tube", "tube.dat")   # FEMALE
        edges = self.scanner.scan(
            parent_id="plate_top",
            child_id="plate_bot",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
        )
        self.assertEqual(len(edges), 8, "8 stud ↔ 8 tube 完美对齐应全 8 对 latch。")

    def test_8_stud_to_4_tube_asymmetric_partial_overlap(self):
        """[Case P2] 8 stud 源（2x4）↔ 4 tube 目标（1x4），目标只覆盖源的中
        间 4 个 → Auto-Latch 应返 4 条边（其余 4 个无目标）。

        镜像前端 predictPlugSnapPairs case 3。
        """
        parent_sites = self._2x4_grid_sites("p", "stud", "stud.dat")  # 8 个
        child_sites = self._1x4_grid_sites("c", "tube", "tube.dat")   # 4 个
        edges = self.scanner.scan(
            parent_id="plate_2x4",
            child_id="plate_1x4",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
        )
        # 4 个 tube 各自找到 x=0 那一列的 stud — 因 1x4 在 x=0
        self.assertEqual(len(edges), 4, "8 stud / 4 tube 部分覆盖应返 4 对。")

    def test_plug_snap_with_main_exclusion_leaves_n_minus_1(self):
        """[Case P3] 8↔8 plug snap，主连接端口对已注册（main_pair exclude）
        → Auto-Latch 应返剩 7 对。模拟"用户 Shift+Click anchor → snap_parts
        把 anchor 作 main，Auto-Latch 闭合其余 plug member"。
        """
        parent_sites = self._2x4_grid_sites("p", "stud", "stud.dat")
        child_sites = self._2x4_grid_sites("c", "tube", "tube.dat")
        # 主连接：parent 的 stud_0 ↔ child 的 tube_0（位置 [0,0,0]）
        edges = self.scanner.scan(
            parent_id="plate_top",
            child_id="plate_bot",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_identity_transform(),
            exclude_port_pair=("stud_0", "tube_0"),
        )
        self.assertEqual(len(edges), 7, "Main pair excluded → 8-1=7 auto-latched。")

    def test_plug_member_beyond_threshold_drops_out(self):
        """[Case P4] 8↔8 网格，子零件整体偏移 5mm > 1mm 阈值 → 0 对。
        证明 Auto-Latch 严守距离阈值，不会因 plug 概念放宽。
        """
        parent_sites = self._2x4_grid_sites("p", "stud", "stud.dat")
        child_sites = self._2x4_grid_sites("c", "tube", "tube.dat")
        edges = self.scanner.scan(
            parent_id="plate_top",
            child_id="plate_bot",
            parent_sites=parent_sites,
            child_sites=child_sites,
            parent_world_transform=_identity_transform(),
            child_world_transform=_translate_transform(0.005, 0.0, 0.0),
        )
        self.assertEqual(len(edges), 0, "整体偏移 5mm，所有 stud↔tube 都超阈值。")


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
        child_sites  = [_make_site("s_c", "peg_c",  "peg.dat",     [0.0, 0.0, 0.0])]
        edges = scanner.scan("A", "B", parent_sites, child_sites, np.eye(4), np.eye(4))

        self.assertEqual(len(edges), 1)
        count = self.manager.batch_connect(edges)
        self.assertEqual(count, 1, "应成功注册 1 条边。")
        # 双向修复后，MALE peg_c(B) 成为 parent: 图中应有 B→A 边
        actual_edge_present = (
            self.manager.graph.has_edge("A", "B")
            or self.manager.graph.has_edge("B", "A")
        )
        self.assertTrue(actual_edge_present, "图中应存在 A-B 之间的边（任意方向）。")

    def test_batch_connect_skips_unknown_nodes(self):
        """
        [BC-2] batch_connect 应跳过涉及图中不存在节点的边，不崩溃。
        """
        scanner = AutoLatchScanner()
        parent_sites = [_make_site("s_p", "hole_p", "peghole.dat", [0.0, 0.0, 0.0])]
        child_sites  = [_make_site("s_c", "peg_c",  "peg.dat",     [0.0, 0.0, 0.0])]
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


class TestSerializePortKey(unittest.TestCase):
    """``serialize_port_key`` 必须与前端 ``store.ts`` 的 ``portKey()`` 输出
    逐字符一致，否则前端写入 ``occupiedPorts`` 后下游查询命中不上。"""

    def test_basic_position_only(self):
        """无 rotation 参数时只输出位置部分，4 位小数。"""
        self.assertEqual(serialize_port_key([0.04, 0.0, 0.012]), "0.0400,0.0000,0.0120")

    def test_negative_zero_normalized(self):
        """负零必须归一化为正零，与 JS ``(-0).toFixed(4)`` 行为一致。
        若不归一化，前端 ``"0.0000"`` 与后端 ``"-0.0000"`` 不匹配。"""
        self.assertEqual(serialize_port_key([-0.0, -0.0, 0.0]), "0.0000,0.0000,0.0000")
        self.assertEqual(
            serialize_port_key([0.0, 0.0, 0.0], np.diag([1.0, 1.0, 1.0])),
            "0.0000,0.0000,0.0000|0.00,0.00,1.00",
        )

    def test_rotation_third_column_extracted(self):
        """rotation 第三列即 Z 轴 (端口出向)，应作为 key 后缀。"""
        rot = np.array([
            [1.0, 0.0,  0.0],
            [0.0, 0.0, -1.0],
            [0.0, 1.0,  0.0],
        ])
        # 第三列 = [0, -1, 0]
        self.assertEqual(
            serialize_port_key([0.02, 0.0, -0.04], rot),
            "0.0200,0.0000,-0.0400|0.00,-1.00,0.00",
        )

    def test_rounding_to_4_and_2_decimals(self):
        """位置 4 位、法线 2 位四舍五入。"""
        rot = np.array([
            [1.0, 0.0,  0.123456],
            [0.0, 1.0,  0.654321],
            [0.0, 0.0, -0.999991],
        ])
        # 注意：position[1] = 0.00005 在 round-half-to-even 下舍入为 0.0000，
        # 选择更明确的 0.00006 以避免依赖具体舍入模式。
        self.assertEqual(
            serialize_port_key([0.123456, 0.00006, -0.99999], rot),
            "0.1235,0.0001,-1.0000|0.12,0.65,-1.00",
        )


class TestServerEndpointResponseShape(unittest.TestCase):
    """``/api/snap_parts`` 响应中 ``auto_latched_edges`` 的契约形状。

    用 FastAPI ``TestClient`` 直连 server 调用，验证响应字段齐备且 portKey
    与 ``serialize_port_key`` 一致。"""

    def test_response_has_auto_latched_edges_field(self):
        from fastapi.testclient import TestClient
        from backend.server import app, topo_manager
        from backend.topology_manager import PartNode

        # 重置图，避免前序测试残留
        topo_manager.graph.clear()
        topo_manager.add_part(PartNode(part_id="dummy_a", name="dummy_a"))
        topo_manager.add_part(PartNode(part_id="dummy_b", name="dummy_b"))

        client = TestClient(app)
        # 用真实库里有 sites 的零件几乎都会触发实参化校验失败；这里只验证
        # 响应字段形状与新增 key 存在性，因此故意不传 world_pos 走兼容分支。
        eye_rot = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        resp = client.post(
            "/api/snap_parts",
            json={
                "parent_id": "dummy_a",
                "child_id": "dummy_b",
                "port_type_p": "peghole.dat",
                "port_type_c": "peg.dat",
                "parent_origin": [0, 0, 0],
                "parent_rot": eye_rot,
                "child_origin": [0, 0, 0],
                "child_rot": eye_rot,
                # 故意省略 world_pos，触发"跳过 AutoLatch"分支
            },
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        # 即使 AutoLatch 被跳过，响应也必须含此键（前端解构需要稳定字段）
        self.assertIn("auto_latched_edges", body)
        self.assertIsInstance(body["auto_latched_edges"], list)
        self.assertEqual(body["auto_latched_count"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

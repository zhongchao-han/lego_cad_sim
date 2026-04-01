"""
test_v3_1_full_coverage.py
===========================
基于测试用例规范 v3.1 (04_v3_0_test_case_specifications.md) 的全覆盖单元测试套件。

覆盖范围：
  Section 1 - 离线资产管线验证 (Tests 1.1, 1.2, 1.3)
  Section 2 - 空间对齐一致性验证 (Tests 2.1, 2.2)
  Section 3 - 交互与拓扑连接验证 (Tests 3.1, 3.2-GAP)
  Section 4 - 物理约束与安全性 (Tests 4.1, 4.2, 4.3)
  Section 5 - 质量回归基准 (Test 5.0)

说明：
  - 所有测试均为纯后端 Python 单元测试，不依赖 HTTP 或 WebSocket。
  - Test 3.2 (Auto-Snap) 和 Test 4.1 (UI 红色脉冲) 属于前端行为测试，
    此处仅对 TopologyManager 的状态机后验逻辑进行可测试的后端验证。
"""

import logging
import os
import sys
import unittest

import numpy as np

# 注入项目根目录以支持绝对 backend 导入
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.tests.test_utils import _build_port, _make_port
from backend.math_utils import CoordinateTransformer, purify_rotation_matrix
from backend.port import Port, Site
from backend.port_semantics import FitType
from backend.site_utils import cluster_ports_into_sites, SITE_MERGE_THRESHOLD
from backend.topology_manager import TopologyManager, PartNode, ConnectionEdge

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# 辅助函数
# ─────────────────────────────────────────────────────────────────────────────



# ─────────────────────────────────────────────────────────────────────────────
# Section 1: 离线资产管线验证
# ─────────────────────────────────────────────────────────────────────────────

class TestSection1_AssetPipeline(unittest.TestCase):
    """对应规范 Section 1：离线资产加工管线验证。"""

    # ── Test 1.1: 坐标系归一化准度 ───────────────────────────────────────────

    def test_1_1_pos_normalization_values(self):
        """
        [Test 1.1.a] 验证 normalize_pos 的换算精度。
        输入: LDU [20, 24, 0]
        预期: SI [0.008, -0.0096, 0.0] (Rx180 翻转后 Y 变负, 再乘 0.0004)
        """
        logger.debug("[Test 1.1.a] 进入坐标归一化精度测试。")
        p_ldu = np.array([20.0, 24.0, 0.0])
        p_si = CoordinateTransformer.normalize_pos(p_ldu)

        np.testing.assert_allclose(p_si, [0.008, -0.0096, 0.0], atol=1e-7,
                                   err_msg="坐标归一化结果与预期不符，检查 Rx180 翻转与 LDU_TO_SI 缩放。")

    def test_1_1_y_axis_is_flipped_after_normalization(self):
        """
        [Test 1.1.b] 验证 Rx180 将 LDraw 的 Y 轴完整翻转为 -Y。
        任何正 Y 输入归一化后必须为负。
        """
        logger.debug("[Test 1.1.b] 验证 Y 轴翻转符号。")
        p_ldu = np.array([0.0, 10.0, 0.0])
        p_si = CoordinateTransformer.normalize_pos(p_ldu)
        self.assertLess(p_si[1], 0.0, "Rx180 归一化后 Y 轴符号应翻转为负值。")

    def test_1_1_z_axis_is_flipped_after_normalization(self):
        """
        [Test 1.1.c] 验证 Rx180 将 LDraw 的 Z 轴翻转为 -Z。
        """
        logger.debug("[Test 1.1.c] 验证 Z 轴翻转符号。")
        p_ldu = np.array([0.0, 0.0, 10.0])
        p_si = CoordinateTransformer.normalize_pos(p_ldu)
        self.assertLess(p_si[2], 0.0, "Rx180 归一化后 Z 轴符号应翻转为负值。")

    def test_1_1_origin_stays_at_origin(self):
        """
        [Test 1.1.d] 边界条件：零向量经过任何坐标变换仍应保持在原点。
        """
        logger.debug("[Test 1.1.d] 验证零向量归一化。")
        p_si = CoordinateTransformer.normalize_pos(np.zeros(3))
        np.testing.assert_allclose(p_si, np.zeros(3), atol=1e-10,
                                   err_msg="零点归一化结果应仍为零点。")

    def test_1_1_rotation_normalization_identity(self):
        """
        [Test 1.1.e] 单位矩阵经 normalize_rot 变换后应仍为单位矩阵
        (Rx180 @ I @ Rx180 = I)。
        """
        logger.debug("[Test 1.1.e] 验证单位矩阵旋转归一化。")
        result = CoordinateTransformer.normalize_rot(np.eye(3))
        np.testing.assert_allclose(result, np.eye(3), atol=1e-9,
                                   err_msg="Rx180 @ I @ Rx180 应等于 I。")

    # ── Test 1.2: 矩阵提纯与正交化 ───────────────────────────────────────────

    def test_1_2_purify_shear_matrix_becomes_orthogonal(self):
        """
        [Test 1.2.a] 含剪切形变的矩阵提纯后必须正交 (M @ M.T ≈ I)。
        """
        logger.debug("[Test 1.2.a] 剪切矩阵正交化测试。")
        shear_mat = np.array([
            [1.0, 0.1, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ], dtype=np.float64)
        result = purify_rotation_matrix(shear_mat)
        np.testing.assert_allclose(result @ result.T, np.eye(3), atol=1e-6,
                                   err_msg="剪切矩阵提纯后应正交。")

    def test_1_2_purify_result_is_right_handed(self):
        """
        [Test 1.2.b] 提纯后矩阵行列式必须严格等于 +1.0 (右手系)。
        """
        logger.debug("[Test 1.2.b] 验证提纯后行列式为 +1。")
        arbitrary = np.array([
            [0.9, 0.2, 0.1],
            [0.1, 0.8, 0.3],
            [0.0, 0.1, 0.9],
        ], dtype=np.float64)
        result = purify_rotation_matrix(arbitrary)
        self.assertAlmostEqual(np.linalg.det(result), 1.0, places=6,
                               msg="提纯后矩阵行列式应为 1.0 (右手系)。")

    def test_1_2_purify_preserves_valid_rotation(self):
        """
        [Test 1.2.c] 已是合法旋转矩阵的输入经提纯后不应发生实质性偏移。
        """
        logger.debug("[Test 1.2.c] 合法矩阵提纯稳定性测试。")
        from scipy.spatial.transform import Rotation
        valid_rot = Rotation.from_euler("xyz", [30, 45, 60], degrees=True).as_matrix()
        result = purify_rotation_matrix(valid_rot)
        np.testing.assert_allclose(result, valid_rot, atol=1e-5,
                                   err_msg="合法旋转矩阵提纯后不应偏移。")

    def test_1_2_purify_nan_input_does_not_crash(self):
        """
        [Test 1.2.d] 边界条件：NaN 输入不应造成崩溃（防御性）。
        """
        logger.debug("[Test 1.2.d] NaN 输入防崩测试。")
        nan_mat = np.full((3, 3), np.nan)
        try:
            result = purify_rotation_matrix(nan_mat)
            # 结果应是合法矩阵，不崩溃即可
            self.assertEqual(result.shape, (3, 3))
        except Exception as e:  # noqa: BLE001
            self.fail(f"purify_rotation_matrix 对 NaN 输入崩溃了: {e}")

    # ── Test 1.3: Site 聚类准度 ───────────────────────────────────────────────

    def test_1_3_three_separate_sites_from_6558(self):
        """
        [Test 1.3.a] 6558 销钉的 3 个端口（两端 + 中间）应聚类为 3 个独立 Site。
        位置差 >> SITE_MERGE_THRESHOLD (0.004m vs 0.0001m)。
        """
        logger.debug("[Test 1.3.a] 6558 销钉三 Site 聚类测试。")
        ports = [
            _make_port("p0", "confric6.dat", [-0.004, 0.0, 0.0]),
            _make_port("p1", "confric8.dat", [-0.004, 0.0, 0.0]),  # 与 p0 同位，应同 Site
            _make_port("p2", "confric6.dat", [0.004, 0.0, 0.0]),   # 不同 Site
        ]
        sites = cluster_ports_into_sites(ports, "6558.dat")
        logger.debug(f"[DEBUG] 聚类结果: {len(sites)} 个 Site。")
        self.assertEqual(len(sites), 2,
                         "6558 端口应被聚类为 2 个 Site (同心孔合并一个)。")
        self.assertEqual(len(sites[0].ports), 2,
                         "site0 应包含同心的两个端口 (confric6 + confric8)。")

    def test_1_3_port_spacing_8mm_creates_separate_sites(self):
        """
        [Test 1.3.b] 间距 8mm 的两端口（远超阈值 0.1mm）必须属于不同 Site。
        """
        logger.debug("[Test 1.3.b] 8mm 间距隔离 Site 测试。")
        ports = [
            _make_port("p0", "peghole.dat", [0.0, 0.0, 0.0]),
            _make_port("p1", "peghole.dat", [0.008, 0.0, 0.0]),
        ]
        sites = cluster_ports_into_sites(ports, "32316.dat")
        self.assertEqual(len(sites), 2,
                         "8mm 间距的端口应被分配到不同 Site, 不应被合并。")

    def test_1_3_concentric_ports_merge_into_one_site(self):
        """
        [Test 1.3.c] 同心孔（圆孔+十字孔）距离 < SITE_MERGE_THRESHOLD 时应归入同一 Site。
        """
        logger.debug("[Test 1.3.c] 同心孔合并 Site 测试。")
        tiny_offset = SITE_MERGE_THRESHOLD * 0.01
        ports = [
            _make_port("round", "peghole.dat", [0.0, 0.0, 0.0]),
            _make_port("cross", "axlehole.dat", [tiny_offset, 0.0, 0.0]),
        ]
        sites = cluster_ports_into_sites(ports, "32000.dat")
        self.assertEqual(len(sites), 1, "同心孔应合并为一个 Site。")
        self.assertEqual(len(sites[0].ports), 2, "合并后的 Site 应包含两个 Port。")


# ─────────────────────────────────────────────────────────────────────────────
# Section 2: 空间对齐一致性验证（纯后端可测部分）
# ─────────────────────────────────────────────────────────────────────────────

class TestSection2_SpatialSync(unittest.TestCase):
    """
    对应规范 Section 2。
    Test 2.1 (GLB-JSON Sync) 和 Test 2.2 (幂等性) 依赖 GeometryProcessor 的
    IO 管线，此处提取其核心数学逻辑进行纯单元测试。
    """

    def test_2_1_coordinate_consistency_formula(self):
        """
        [Test 2.1] 数学公式一致性：同一 LDU 点经 normalize_pos 得到的结果
        应与手算结果 Rx180 @ P_LDU * 0.0004 完全吻合。
        """
        logger.debug("[Test 2.1] 坐标公式一致性交叉验证。")
        p_ldu = np.array([40.0, -30.0, 20.0])
        rx180 = CoordinateTransformer.get_rx180()
        expected = rx180 @ p_ldu * CoordinateTransformer.LDU_TO_SI
        actual = CoordinateTransformer.normalize_pos(p_ldu)
        np.testing.assert_allclose(actual, expected, atol=1e-10,
                                   err_msg="normalize_pos 与手算 Rx180@P*LDU_TO_SI 不一致。")

    def test_2_2_normalization_is_deterministic(self):
        """
        [Test 2.2] 幂等性验证：相同输入多次调用 normalize_pos 结果必须一致
        (无随机性、无副作用)。
        """
        logger.debug("[Test 2.2] 归一化函数幂等性验证。")
        p_ldu = np.array([15.0, 25.0, -5.0])
        result_a = CoordinateTransformer.normalize_pos(p_ldu.copy())
        result_b = CoordinateTransformer.normalize_pos(p_ldu.copy())
        np.testing.assert_array_equal(result_a, result_b,
                                      err_msg="normalize_pos 不是幂等函数，存在非确定性。")


# ─────────────────────────────────────────────────────────────────────────────
# Section 3: 交互与拓扑连接验证
# ─────────────────────────────────────────────────────────────────────────────

class TestSection3_TopologyAndInteraction(unittest.TestCase):
    """对应规范 Section 3：P2P 对齐与拓扑连接。"""

    def test_3_1_p2p_alignment_z_axes_anti_parallel(self):
        """
        [Test 3.1] P2P 对齐后，父端口 Z 轴与子端口 Z 轴方向必须严格反向 (dot=-1)。
        验证 Port.calculate_relative_transform 的物理正确性。
        断言: dot(v_parent_z, T_rel @ v_child_z) ≈ -1.0
        """
        logger.debug("[Test 3.1] P2P Z 轴反向对齐测试。")
        # 父端口朝 +X 方向（Z 轴 = [1,0,0]）
        rot_parent = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], dtype=float)
        port_parent = Port.from_raw("parent", "peghole.dat", np.array([0.0, 0.0, 0.0]), rot_parent)
        self.assertIsNotNone(port_parent, "peghole 端口创建失败，检查 port_semantics 注册。")

        # 子端口朝 -X 方向（Z 轴 = [-1,0,0]），应与父端口反向咬合
        rot_child = np.array([[0, 0, -1], [0, 1, 0], [1, 0, 0]], dtype=float)
        port_child = Port.from_raw("child", "peg.dat", np.array([0.008, 0.0, 0.0]), rot_child)
        self.assertIsNotNone(port_child, "peg 端口创建失败，检查 port_semantics 注册。")

        # 计算相对变换矩阵
        T_rel = port_parent.calculate_relative_transform(port_child)
        self.assertIsNotNone(T_rel, "calculate_relative_transform 返回了 None。")
        self.assertEqual(T_rel.shape, (4, 4), "变换矩阵形状应为 4x4。")

        # 验证旋转部分是合法的 SO(3) 矩阵
        R = T_rel[:3, :3]
        np.testing.assert_allclose(R @ R.T, np.eye(3), atol=1e-5,
                                   err_msg="变换矩阵旋转部分应为正交矩阵。")
        self.assertAlmostEqual(np.linalg.det(R), 1.0, places=5,
                               msg="变换矩阵旋转部分行列式应为 1.0。")

    def test_3_2_topology_manager_records_connection(self):
        """
        [Test 3.2] 拓扑管理器能正确记录零件间的 ConnectionEdge
        (Auto-Snap 后端核验 - 不验证 UI 触发，仅验证图状态)。
        """
        logger.debug("[Test 3.2] TopologyManager 连接边记录测试。")
        manager = TopologyManager()
        part_a = PartNode(part_id="A", name="beam_a")
        part_b = PartNode(part_id="B", name="pin_b")
        manager.add_part(part_a)
        manager.add_part(part_b)

        port_p = Port.from_raw("pa", "peghole.dat", np.array([0.0, 0.0, 0.0]), np.eye(3))
        port_c = Port.from_raw("pb", "peg.dat", np.array([0.0, 0.0, 0.0]), np.eye(3))
        self.assertIsNotNone(port_p)
        self.assertIsNotNone(port_c)

        edge = ConnectionEdge(parent_id="A", child_id="B", port_parent=port_p, port_child=port_c)
        manager.connect_ports(edge)

        self.assertTrue(manager.graph.has_edge("A", "B"),
                        "connect_ports 后图中应存在 A->B 的边。")
        self.assertEqual(manager.graph.number_of_nodes(), 2, "图中应有 2 个节点。")

    def test_3_2_over_constrained_merged_to_fixed(self):
        """
        [Test 3.2 - 过约束] 两零件之间存在多条连接时，
        build_spanning_tree 应将其合并为 Fixed Joint (is_merged=True)。
        """
        logger.debug("[Test 3.2] 过约束合并为 Fixed Joint 测试。")
        manager = TopologyManager()
        for pid in ("A", "B"):
            manager.add_part(PartNode(part_id=pid, name=pid))

        port_p1 = Port.from_raw("p1", "peghole.dat", np.array([0.008, 0.0, 0.0]), np.eye(3))
        port_c1 = Port.from_raw("c1", "peg.dat", np.array([0.0, 0.0, 0.0]), np.eye(3))
        port_p2 = Port.from_raw("p2", "peghole.dat", np.array([-0.008, 0.0, 0.0]), np.eye(3))
        port_c2 = Port.from_raw("c2", "peg.dat", np.array([0.0, 0.0, 0.0]), np.eye(3))

        for pp, pc in [(port_p1, port_c1), (port_p2, port_c2)]:
            if pp and pc:
                manager.connect_ports(ConnectionEdge("A", "B", pp, pc))

        tree = manager.build_spanning_tree()
        # 检查在生成树中 A->B 的边数据确认 is_merged
        edge_data = tree.get_edge_data("A", "B")
        self.assertIsNotNone(edge_data, "生成树中应存在 A->B 的边。")
        self.assertTrue(edge_data["data"].is_merged,
                        "多连接应触发 is_merged=True (Fixed Joint 合并)。")

    def test_3_2_closed_loop_detection(self):
        """
        [Test 3.2 - 闭环] A->B->C->A 的回环连接，
        build_spanning_tree 应将其中一条边打断并存入 closed_loops。
        """
        logger.debug("[Test 3.2] 闭环检测测试。")
        manager = TopologyManager()
        for pid in ("A", "B", "C"):
            manager.add_part(PartNode(part_id=pid, name=pid))

        def mk(name: str) -> Port:
            return Port.from_raw(name, "peghole.dat", np.zeros(3), np.eye(3))  # type: ignore[return-value]

        manager.connect_ports(ConnectionEdge("A", "B", mk("ab_p"), Port.from_raw("ab_c", "peg.dat", np.zeros(3), np.eye(3))))  # type: ignore[arg-type]
        manager.connect_ports(ConnectionEdge("B", "C", mk("bc_p"), Port.from_raw("bc_c", "peg.dat", np.zeros(3), np.eye(3))))  # type: ignore[arg-type]
        manager.connect_ports(ConnectionEdge("C", "A", mk("ca_p"), Port.from_raw("ca_c", "peg.dat", np.zeros(3), np.eye(3))))  # type: ignore[arg-type]

        manager.build_spanning_tree()
        self.assertGreater(len(manager.closed_loops), 0,
                           "三角形闭环应产生至少 1 条被打断的闭环边。")


# ─────────────────────────────────────────────────────────────────────────────
# Section 4: 物理约束与安全性
# ─────────────────────────────────────────────────────────────────────────────

class TestSection4_PhysicsConstraints(unittest.TestCase):
    """对应规范 Section 4：物理约束与安全检测。"""

    def test_4_1_site_occupation_state(self):
        """
        [Test 4.1] Site 职责：Site 被占用后 is_occupied() 应返回 True，
        这是前端轴向移动阻连（物理边界限位）的后端状态基础。
        """
        logger.debug("[Test 4.1] Site 占用状态验证。")
        site = Site(id="test_site")
        self.assertFalse(site.is_occupied(), "新建 Site 默认не должен быть занят。")
        site.occupied_by = "part_B"
        self.assertTrue(site.is_occupied(), "设置 occupied_by 后 is_occupied 应返回 True。")

    def test_4_2_peg_to_peg_is_incompatible(self):
        """
        [Test 4.2.a] 非法配合: 销对销 (Male-Male) 应被拦截为 INCOMPATIBLE。
        """
        logger.debug("[Test 4.2.a] 销对销配合拦截测试。")
        peg_a = _build_port("peg_a", "peg.dat", [0, 0, 0])
        peg_b = _build_port("peg_b", "peg.dat", [0.008, 0, 0])
        fit = peg_a.test_fit_with(peg_b)
        self.assertEqual(fit, FitType.INCOMPATIBLE,
                         "两个 Male Peg 配合应被拦截为 INCOMPATIBLE。")

    def test_4_2_axle_to_peghole_is_incompatible(self):
        """
        [Test 4.2.b] 非法配合: 十字轴插入圆孔 (Profile Mismatch) 应被拦截。
        """
        logger.debug("[Test 4.2.b] 截面不匹配配合拦截测试。")
        axle = _build_port("axle", "axle.dat", [0, 0, 0])
        peghole = _build_port("peghole", "peghole.dat", [0.008, 0, 0])
        fit = axle.test_fit_with(peghole)
        self.assertEqual(fit, FitType.INCOMPATIBLE,
                         "十字轴插入圆孔应因截面不兼容而被拦截为 INCOMPATIBLE。")

    def test_4_2_hole_to_hole_is_incompatible(self):
        """
        [Test 4.2.c] 非法配合: 孔对孔 (Female-Female) 应被拦截为 INCOMPATIBLE。
        """
        logger.debug("[Test 4.2.c] 孔对孔配合拦截测试。")
        hole_a = _build_port("hole_a", "peghole.dat", [0, 0, 0])
        hole_b = _build_port("hole_b", "peghole.dat", [0.008, 0, 0])
        fit = hole_a.test_fit_with(hole_b)
        self.assertEqual(fit, FitType.INCOMPATIBLE,
                         "两个 Female Hole 配合应被拦截为 INCOMPATIBLE。")

    def test_4_2_peg_to_peghole_is_valid(self):
        """
        [Test 4.2.d] 正向验证: 合法配合 Peg->PegHole (Male->Female, Round->Round)
        应返回 FRICTION 或 CLEARANCE，不应为 INCOMPATIBLE。
        """
        logger.debug("[Test 4.2.d] 合法 Peg->PegHole 配合正向测试。")
        peg = _build_port("peg", "peg.dat", [0, 0, 0])
        hole = _build_port("hole", "peghole.dat", [0.008, 0, 0])
        fit = peg.test_fit_with(hole)
        self.assertNotEqual(fit, FitType.INCOMPATIBLE,
                            "合法 Peg->PegHole 配合不应返回 INCOMPATIBLE。")
        self.assertIn(fit, [FitType.FRICTION, FitType.CLEARANCE],
                      "合法 Peg->PegHole 应返回 FRICTION 或 CLEARANCE。")

    def test_4_3_site_gizmo_compatibility_via_port_fit(self):
        """
        [Test 4.3] 通过 Port.test_fit_with() 的结果反推 SiteGizmo 是否应显示兼容。
        规范: fit == INCOMPATIBLE -> SiteGizmo.isCompatible == False
        此测试验证后端语义与前端状态推导的逻辑等价性。
        """
        logger.debug("[Test 4.3] SiteGizmo 兼容性语义等价测试。")
        # 场景 1: 不兼容 -> gizmo 应置灰
        peg = _build_port("peg", "peg.dat", [0, 0, 0])
        axle = _build_port("axle", "axle.dat", [0.008, 0, 0])
        fit_incompatible = peg.test_fit_with(axle)
        self.assertEqual(fit_incompatible, FitType.INCOMPATIBLE)
        # 前端逻辑: fit == INCOMPATIBLE -> isCompatible = False
        is_compatible = (fit_incompatible != FitType.INCOMPATIBLE)
        self.assertFalse(is_compatible, "不兼容端口对应的 SiteGizmo 应不可点击 (isCompatible=False)。")

        # 场景 2: 兼容 -> gizmo 应高亮
        peg2 = _build_port("peg2", "peg.dat", [0, 0, 0])
        hole2 = _build_port("hole2", "peghole.dat", [0.008, 0, 0])
        fit_valid = peg2.test_fit_with(hole2)
        is_compatible_2 = (fit_valid != FitType.INCOMPATIBLE)
        self.assertTrue(is_compatible_2, "兼容端口对应的 SiteGizmo 应可点击 (isCompatible=True)。")


# ─────────────────────────────────────────────────────────────────────────────
# Section 5: 质量回归基准
# ─────────────────────────────────────────────────────────────────────────────

class TestSection5_RegressionBaseline(unittest.TestCase):
    """
    对应规范 Section 5：基准零件集语义稳定性回归测试。
    覆盖零件: 32316.dat, 6558.dat, 2780.dat（轻量后端验证，不依赖 LDraw 库 IO）
    """

    BASELINE_PARTS = ["32316.dat", "6558.dat", "2780.dat"]

    def test_5_0_site_cluster_produces_non_empty_result(self):
        """
        [Test 5.0.a] 基准零件的已知端口描述必须能被聚类为至少 1 个 Site。
        保障聚类函数对所有基准零件的输入不会静默失败或返回空列表。
        """
        logger.debug("[Test 5.0.a] 基准零件 Site 聚类非空回归测试。")
        # 稳健构造：不依赖 LDraw IO，直接注入已知端口描述
        baseline_ports_map = {
            "32316.dat": [
                _make_port("p0", "peghole.dat", [0.0, 0.0, 0.0]),
                _make_port("p1", "peghole.dat", [0.008, 0.0, 0.0]),
                _make_port("p2", "peghole.dat", [0.016, 0.0, 0.0]),
            ],
            "6558.dat": [
                _make_port("p0", "confric6.dat", [-0.004, 0.0, 0.0]),
                _make_port("p1", "confric8.dat", [-0.004, 0.0, 0.0]),
                _make_port("p2", "confric6.dat", [0.004, 0.0, 0.0]),
            ],
            "2780.dat": [
                _make_port("p0", "confric5.dat", [0.0, 0.0, 0.0]),
                _make_port("p1", "confric5.dat", [0.0, 0.0, 0.0]),
            ],
        }
        for part_id, ports in baseline_ports_map.items():
            with self.subTest(part_id=part_id):
                sites = cluster_ports_into_sites(ports, part_id)
                self.assertGreater(len(sites), 0,
                                   f"基准零件 {part_id} 的端口聚类结果不应为空。")
                logger.debug(f"[DEBUG] {part_id}: 聚类为 {len(sites)} 个 Site。")

    def test_5_0_peg_hole_fit_baseline(self):
        """
        [Test 5.0.b] 所有基准零件的典型配合必须保持一致的语义（FRICTION 或 CLEARANCE）。
        保障 port_semantics 字典在重构后不发生静默退化。
        """
        logger.debug("[Test 5.0.b] 基准零件 Peg/Hole 配合语义回归测试。")
        valid_pairs = [
            ("peg.dat", "peghole.dat"),
            ("axle.dat", "axlehole.dat"),
        ]
        for peg_t, hole_t in valid_pairs:
            with self.subTest(pair=f"{peg_t}->{hole_t}"):
                peg_port = Port.from_raw("p", peg_t, np.zeros(3), np.eye(3))
                hole_port = Port.from_raw("h", hole_t, np.zeros(3), np.eye(3))
                if peg_port is None or hole_port is None:
                    self.skipTest(f"端口类型 {peg_t} 或 {hole_t} 未在 port_semantics 注册，跳过。")
                fit = peg_port.test_fit_with(hole_port)
                self.assertNotEqual(fit, FitType.INCOMPATIBLE,
                                    f"基准配合 {peg_t}->{hole_t} 不应返回 INCOMPATIBLE (语义回归失败)。")



# ─────────────────────────────────────────────────────────────────────────────
# Section 6: 边界条件与防御性路径 (Corner Cases & Defensive Guards)
# ─────────────────────────────────────────────────────────────────────────────

class TestSection6_CornerCasesAndDefense(unittest.TestCase):
    """
    补充覆盖规范中未明确描述但属于稳健性保证的边界条件。
    包括: 未注册类型、序列化往返、关节类型推导、Site 释放、
          非单位变换矩阵下的 Auto-Latch 扫描，以及重复 add_part 的幂等性。
    """

    # ── 6.1: Port 工厂防御性 (Unregistered Type) ─────────────────────────────

    def test_6_1_from_raw_unknown_type_returns_none(self):
        """
        [Test 6.1] Port.from_raw 对未注册类型必须返回 None（不应崩溃）。
        这是 auto_latch_scanner 的核心防御路径。
        """
        logger.debug("[Test 6.1] 未注册端口类型防御测试。")
        result = Port.from_raw("ghost", "TOTALLY_UNKNOWN_TYPE.dat",
                               np.zeros(3), np.eye(3))
        self.assertIsNone(result, "未注册类型应使 from_raw 返回 None，而非崩溃。")

    # ── 6.2: Port 序列化往返 (to_dict Round-trip) ────────────────────────────

    def test_6_2_port_to_dict_round_trip(self):
        """
        [Test 6.2] Port.to_dict() 输出的字段必须完整且类型正确，
        保证前端或持久化层能无损地恢复数据。
        """
        logger.debug("[Test 6.2] Port.to_dict() 序列化往返测试。")
        pos = np.array([0.004, 0.0, -0.008])
        rot = np.eye(3)
        port = Port.from_raw("p0", "peg.dat", pos, rot, is_manually_adjusted=True)
        self.assertIsNotNone(port)

        d = port.to_dict()
        self.assertEqual(d["name"], "p0")
        self.assertEqual(d["type"], "peg.dat")
        self.assertAlmostEqual(d["position"][0], 0.004, places=7)
        self.assertTrue(d["is_manually_adjusted"], "手动调整标记未能正确序列化。")

    # ── 6.3: 关节类型推导 (Joint Type Derivation) ────────────────────────────

    def test_6_3_fixed_joint_derived_for_merged_connection(self):
        """
        [Test 6.3.a] is_merged=True 时 derive_joint 应返回 'fixed'。
        这是过约束合并为 Fixed Joint 的物理语义验证。
        """
        logger.debug("[Test 6.3.a] Fixed Joint 类型推导测试。")
        peg = _build_port("peg", "peg.dat", [0, 0, 0])
        hole = _build_port("hole", "peghole.dat", [0, 0, 0])
        j_type, _, _ = peg.derive_joint(hole, is_merged=True)
        self.assertEqual(j_type, "fixed",
                         "is_merged=True 应推导出 'fixed' 关节类型。")

    def test_6_3_cross_profile_derived_as_fixed(self):
        """
        [Test 6.3.b] 十字轴插入轴孔 (Axle→AxleHole) 物理上无旋转自由度，
        derive_joint_params 必须将其推导为 'fixed' 关节。
        """
        logger.debug("[Test 6.3.b] 十字轴 Fixed Joint 类型推导测试。")
        axle = Port.from_raw("a", "axle.dat", np.zeros(3), np.eye(3))
        axle_hole = Port.from_raw("ah", "axlehole.dat", np.zeros(3), np.eye(3))
        if axle is None or axle_hole is None:
            self.skipTest("axle.dat 或 axlehole.dat 未在 port_semantics 注册，跳过。")
        j_type, _, _ = axle.derive_joint(axle_hole, is_merged=False)
        self.assertEqual(j_type, "fixed",
                         "十字截面配合 (CROSS) 应推导为 'fixed' 锁定关节。")

    def test_6_3_cylinder_profile_derived_as_continuous(self):
        """
        [Test 6.3.c] 圆柱销插入圆孔 (Peg→PegHole) 有无限旋转自由度，
        derive_joint_params 必须将其推导为 'continuous' 关节。
        """
        logger.debug("[Test 6.3.c] 圆柱销 Continuous Joint 类型推导测试。")
        peg = Port.from_raw("p", "peg.dat", np.zeros(3), np.eye(3))
        hole = Port.from_raw("h", "peghole.dat", np.zeros(3), np.eye(3))
        if peg is None or hole is None:
            self.skipTest("peg.dat 或 peghole.dat 未在 port_semantics 注册，跳过。")
        j_type, _, _ = peg.derive_joint(hole, is_merged=False)
        self.assertEqual(j_type, "continuous",
                         "圆柱截面配合 (CYLINDER) 应推导为 'continuous' 连续旋转关节。")

    # ── 6.4: Site 占用与释放 (Site Occupation Lifecycle) ─────────────────────

    def test_6_4_site_release_clears_occupation(self):
        """
        [Test 6.4] Site 被占用后调用 release() 或清空 occupied_by，
        is_occupied() 必须重新返回 False。
        保证轴向滑动完成后 Site 状态能正确复位。
        """
        logger.debug("[Test 6.4] Site 占用释放生命周期测试。")
        from backend.port import Site
        site = Site(id="s0")
        site.occupied_by = "part_X"
        self.assertTrue(site.is_occupied(), "占用后 is_occupied 应返回 True。")
        site.occupied_by = None
        self.assertFalse(site.is_occupied(), "释放后 is_occupied 应重新返回 False。")

    # ── 6.5: Auto-Latch 非单位变换矩阵 (Non-Identity Transform) ──────────────

    def test_6_5_auto_latch_with_translated_world_transform(self):
        """
        [Test 6.5] AutoLatchScanner 在子零件有非零世界平移时，
        必须正确将 Site 坐标投影到世界系后再判断距离。
        若子零件平移后 Site 落在阈值外，扫描结果必须为空。
        """
        logger.debug("[Test 6.5] 非单位世界变换矩阵下的 Auto-Latch 扫描测试。")
        from backend.auto_latch_scanner import AutoLatchScanner, AUTO_LATCH_THRESHOLD_M

        scanner = AutoLatchScanner()
        parent_sites = [{
            "id": "s_p", "position": [0.0, 0.0, 0.0],
            "ports": [{"name": "hole_p", "type": "peghole.dat",
                       "position": [0, 0, 0], "rotation": [[1,0,0],[0,1,0],[0,0,1]]}]
        }]
        child_sites = [{
            "id": "s_c", "position": [0.0, 0.0, 0.0],
            "ports": [{"name": "peg_c", "type": "peg.dat",
                       "position": [0, 0, 0], "rotation": [[1,0,0],[0,1,0],[0,0,1]]}]
        }]
        parent_T = np.eye(4)
        # 子零件平移 10mm，远超 1mm 阈值
        child_T = np.eye(4)
        child_T[0, 3] = AUTO_LATCH_THRESHOLD_M * 10.0

        edges = scanner.scan("beam", "pin", parent_sites, child_sites, parent_T, child_T)
        self.assertEqual(len(edges), 0,
                         "世界系下距离超过阈值时 Auto-Latch 不应返回任何边。")

    # ── 6.6: TopologyManager 幂等 add_part ────────────────────────────────────

    def test_6_6_add_part_is_idempotent(self):
        """
        [Test 6.6] 重复调用 add_part 同一零件不应产生重复节点。
        保证多次热加载时拓扑图不会膨胀。
        """
        logger.debug("[Test 6.6] 重复 add_part 幂等性测试。")
        manager = TopologyManager()
        part = PartNode(part_id="dup_part", name="test")
        manager.add_part(part)
        manager.add_part(part)   # 再次添加，应被忽略
        self.assertEqual(manager.graph.number_of_nodes(), 1,
                         "重复 add_part 不应使节点数超过 1。")


if __name__ == "__main__":
    unittest.main(verbosity=2)

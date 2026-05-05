"""
test_urdf_exporter.py
======================
覆盖 backend/urdf_exporter.py 的 L45 / L44b 改造：
  - 闭环边写 SDF 1.9 风格 <gazebo><joint>，不再用虚构 <plugin>
  - 齿轮对（轴线平行 + 中心距匹配）给 follower joint 生成 <mimic>
  - L44b 中介齿轮链：齿轮 axlehole 卡 axle 上（fixed）+ axle 在 beam 圆孔中
    spin（continuous），mimic 必须加在齿轮所在 cluster 的 effective spin joint 上
  - 退化场景：垂直轴 / 距离不匹配 / 共轴 / 缺 ldraw_parts_dir → 无 mimic
  - L44b 退化：同 axle 多齿轮（同 cluster）无 mimic；钉死 cluster 内齿轮跳过
"""
from __future__ import annotations

import os
import sys
import unittest
import xml.etree.ElementTree as ET
from tempfile import TemporaryDirectory

import networkx as nx
import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.connection_edge import ConnectionEdge  # noqa: E402
from backend.port import Port  # noqa: E402
from backend.topology_manager import PartNode, TopologyManager  # noqa: E402
from backend.urdf_exporter import LEGO_GEAR_MODULE_M, URDFExporter  # noqa: E402


# ─── 测试夹具 ──────────────────────────────────────────────────────────────

def _mk_port(name: str, ldraw_type: str, pos, part_id: str = "Test") -> Port:
    port = Port.from_raw(
        name, ldraw_type, np.array(pos, dtype=float), np.eye(3),
        part_context=part_id,
    )
    if port is None:
        raise RuntimeError(f"无法创建测试 Port: {ldraw_type}")
    return port


def _mk_part(part_id: str, ldraw_id=None, world_pos=None, world_rot=None) -> PartNode:
    node = PartNode(part_id=part_id, name=part_id, ldraw_id=ldraw_id)
    if world_pos is not None or world_rot is not None:
        T = np.eye(4)
        if world_rot is not None:
            T[:3, :3] = np.array(world_rot)
        if world_pos is not None:
            T[:3, 3] = np.array(world_pos)
        node.global_transform = T
    return node


def _write_fake_dat(parts_dir: str, ldraw_id: str, description: str) -> None:
    with open(os.path.join(parts_dir, ldraw_id), "w", encoding="utf-8") as f:
        f.write(f"0 {description}\n")


# ─── 闭环测试 ──────────────────────────────────────────────────────────────

class TestClosedLoopExport(unittest.TestCase):
    """3-beam 三角形的 closed_loop 边必须以 <gazebo><joint> 形式落到 URDF。"""

    def setUp(self) -> None:
        # 三 beam + 三 pin 连接，topology 解环后会有 1 条 closed_loop
        self.tm = TopologyManager()
        self.tm.add_part(_mk_part("A"))
        self.tm.add_part(_mk_part("B"))
        self.tm.add_part(_mk_part("C"))
        self.tm.connect_ports(ConnectionEdge(
            "A", "B", _mk_port("p", "peghole", [0, 0, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        self.tm.connect_ports(ConnectionEdge(
            "B", "C", _mk_port("p", "peghole", [0, 0, 0]), _mk_port("c", "pin", [0, 0, 0]),
        ))
        self.tm.connect_ports(ConnectionEdge(
            "C", "A", _mk_port("p", "pin", [0, 0, 0]), _mk_port("c", "peghole", [0, 0, 0]),
        ))

    def _export_and_parse(self) -> ET.Element:
        tree = self.tm.build_spanning_tree()
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter().export(tree, self.tm.closed_loops, out)
            return ET.parse(out).getroot()

    def test_closed_loop_emits_gazebo_joint_not_plugin(self):
        root = self._export_and_parse()
        gazebos = root.findall('gazebo')
        self.assertEqual(len(gazebos), 1, "三角形应产生 1 条 closed_loop → 1 个 <gazebo>")
        gz = gazebos[0]
        # SDF 1.9 形式
        self.assertIsNotNone(gz.find('joint'), "<gazebo> 内必须含 <joint>")
        self.assertIsNone(gz.find('plugin'), "L45 不应再写 <plugin> 虚构格式")

    def test_closed_loop_joint_has_required_sdf_fields(self):
        root = self._export_and_parse()
        gj = root.find('gazebo/joint')
        self.assertIsNotNone(gj)
        assert gj is not None  # mypy
        # 必有 name + type + parent + child + pose
        self.assertTrue(gj.get('name', '').startswith('loop_joint_'))
        self.assertIn(gj.get('type'), ('fixed', 'continuous', 'revolute', 'prismatic'))
        parent_el = gj.find('parent')
        child_el = gj.find('child')
        pose_el = gj.find('pose')
        self.assertIsNotNone(parent_el)
        self.assertIsNotNone(child_el)
        self.assertIsNotNone(pose_el)
        # parent / child 的 text 必须落到主树某 link
        link_names = {link_el.get('name') for link_el in root.findall('link')}
        assert parent_el is not None and child_el is not None  # mypy
        self.assertIn(parent_el.text, link_names)
        self.assertIn(child_el.text, link_names)


# ─── 齿轮 Mimic 测试 ───────────────────────────────────────────────────────

class TestGearMimicExport(unittest.TestCase):
    """两齿轮平行轴 + 距离匹配时，URDF follower joint 必须含 <mimic>。"""

    def setUp(self) -> None:
        # TemporaryDirectory 必须挂在 self 上活到测试方法结束 —— 否则 helper 函数
        # 返回时被 GC 立即删目录，下游 get_part_name 读不到 .dat。
        self._tmp_dir: TemporaryDirectory[str] | None = None

    def tearDown(self) -> None:
        if self._tmp_dir is not None:
            self._tmp_dir.cleanup()
            self._tmp_dir = None

    def _build_two_gear_tree(
        self,
        tooth_a: int = 24, tooth_b: int = 24,
        gap: float = None,  # type: ignore[assignment]
        axis_b=None,
    ) -> tuple[nx.DiGraph, list, str]:
        """构造：frame → gear_a (continuous) ; frame → gear_b (continuous)。
        gap = 中心距（X 方向）；axis_b = gear_b 局部 +Z 在世界的方向，默认平行。"""
        if gap is None:
            gap = (tooth_a + tooth_b) / 2 * LEGO_GEAR_MODULE_M
        self._tmp_dir = TemporaryDirectory()
        tmp_name = self._tmp_dir.name
        # 写 fake .dat 让 extract_tooth_count 命中
        _write_fake_dat(tmp_name, "gA.dat", f"Technic Gear {tooth_a} Tooth Test")
        _write_fake_dat(tmp_name, "gB.dat", f"Technic Gear {tooth_b} Tooth Test")

        tm = TopologyManager()
        # 单 frame 直接接两个齿轮：齿轮的 child joint 本身就是 continuous（pin/peghole）。
        # 真实 LEGO 中介齿轮链（gear locked to axle，axle 在 beam 里旋转）由 L44b
        # 的 fixed-cluster 算法覆盖，单独 TestGearMimicAxleMediated 测试。
        tm.add_part(_mk_part("frame"))
        rot_b = np.eye(3) if axis_b is None else _rot_to_align_z(axis_b)
        tm.add_part(_mk_part("gear_a", ldraw_id="gA.dat", world_pos=[0, 0, 0]))
        tm.add_part(_mk_part("gear_b", ldraw_id="gB.dat", world_pos=[gap, 0, 0], world_rot=rot_b))

        # frame ↔ gear 用 pin/peghole 触发 continuous —— derive_joint 要求
        # plug=MALE(pin) + socket=FEMALE(peghole)，反着写就走 INCOMPATIBLE 路径变 fixed
        tm.connect_ports(ConnectionEdge(
            "frame", "gear_a",
            _mk_port("p", "pin", [0, 0, 0]),
            _mk_port("c", "peghole", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "frame", "gear_b",
            _mk_port("p", "pin", [0, 0, 0]),
            _mk_port("c", "peghole", [0, 0, 0]),
        ))
        tree = tm.build_spanning_tree()
        return tree, tm.closed_loops, tmp_name

    def _export(self, tree, loops, parts_dir) -> ET.Element:
        with TemporaryDirectory() as out_dir:
            out = os.path.join(out_dir, "out.urdf")
            URDFExporter(ldraw_parts_dir=parts_dir).export(tree, loops, out)
            return ET.parse(out).getroot()

    def test_two_24t_gears_at_correct_distance_emit_mimic(self):
        tree, loops, parts_dir = self._build_two_gear_tree(24, 24)
        root = self._export(tree, loops, parts_dir)

        joints = {j.get('name'): j for j in root.findall('joint')}
        gear_b_joint = next(
            (j for name, j in joints.items() if name and name.endswith('_to_gear_b')), None,
        )
        self.assertIsNotNone(gear_b_joint, "应存在 axle2→gear_b 的 joint")
        assert gear_b_joint is not None  # mypy
        mimic = gear_b_joint.find('mimic')
        self.assertIsNotNone(mimic, "follower 齿轮 joint 必须有 <mimic>")
        assert mimic is not None  # mypy
        self.assertTrue(mimic.get('joint', '').endswith('_to_gear_a'))
        # 24/24 外啮合 multiplier = -1
        self.assertAlmostEqual(float(mimic.get('multiplier', '0')), -1.0, places=4)

    def test_asymmetric_gear_pair_correct_multiplier(self):
        # 12-tooth ↔ 24-tooth：multiplier = -12/24 = -0.5
        tree, loops, parts_dir = self._build_two_gear_tree(12, 24)
        root = self._export(tree, loops, parts_dir)
        joints = {j.get('name'): j for j in root.findall('joint')}
        gear_b_joint = next(
            (j for name, j in joints.items() if name and name.endswith('_to_gear_b')), None,
        )
        assert gear_b_joint is not None
        mimic = gear_b_joint.find('mimic')
        assert mimic is not None
        self.assertAlmostEqual(float(mimic.get('multiplier', '0')), -0.5, places=4)

    def test_no_mimic_when_distance_off(self):
        tree, loops, parts_dir = self._build_two_gear_tree(24, 24, gap=0.05)  # 远超 mesh 距离
        root = self._export(tree, loops, parts_dir)
        for joint in root.findall('joint'):
            self.assertIsNone(
                joint.find('mimic'),
                f"距离不匹配时 joint {joint.get('name')!r} 不应有 <mimic>",
            )

    def test_no_mimic_when_axes_perpendicular(self):
        # gear_b 的局部 Z 转到世界 +X 方向 → 与 gear_a 的 Z (世界 +Z) 垂直
        tree, loops, parts_dir = self._build_two_gear_tree(24, 24, axis_b=[1, 0, 0])
        root = self._export(tree, loops, parts_dir)
        for joint in root.findall('joint'):
            self.assertIsNone(joint.find('mimic'))

    def test_no_mimic_without_ldraw_parts_dir(self):
        # 同样的 mesh-ready 几何，但 ldraw_parts_dir=None → 走老行为
        tree, loops, _ = self._build_two_gear_tree(24, 24)
        with TemporaryDirectory() as out_dir:
            out = os.path.join(out_dir, "out.urdf")
            URDFExporter(ldraw_parts_dir=None).export(tree, loops, out)
            root = ET.parse(out).getroot()
        for joint in root.findall('joint'):
            self.assertIsNone(joint.find('mimic'))


# ─── L44b 中介齿轮链测试 ───────────────────────────────────────────────────

class TestGearMimicAxleMediated(unittest.TestCase):
    """L44b：齿轮 axlehole 卡 axle 上 → 齿轮 child joint = fixed；mimic 必须加在
    齿轮所在 fixed-cluster 的 effective spin joint（axle 与 beam 之间的 continuous
    joint）上。同 cluster 内多齿轮自然共转，不写 mimic。"""

    def setUp(self) -> None:
        self._tmp_dir: TemporaryDirectory[str] | None = None

    def tearDown(self) -> None:
        if self._tmp_dir is not None:
            self._tmp_dir.cleanup()
            self._tmp_dir = None

    def _build_axle_mediated_chain(
        self,
        tooth_a: int = 24,
        tooth_b: int = 24,
        gap: float = None,  # type: ignore[assignment]
    ) -> tuple[nx.DiGraph, list, str]:
        """构造典型中介齿轮链：
            frame → axle_a (continuous, pin/peghole)
            axle_a → gear_a (fixed, axle/axlehole)  ← gear_a 锁在 axle_a 上
            frame → axle_b (continuous, pin/peghole)
            axle_b → gear_b (fixed, axle/axlehole)  ← gear_b 锁在 axle_b 上
        几何：两 axle 都 +Z 方向；gear_a 在 (0,0,0)，gear_b 在 (gap, 0, 0)。
        预期：gear_a 与 gear_b mesh → mimic 加在 frame→axle_b 的 continuous joint
        上，引用 frame→axle_a 的 continuous joint。"""
        if gap is None:
            gap = (tooth_a + tooth_b) / 2 * LEGO_GEAR_MODULE_M
        self._tmp_dir = TemporaryDirectory()
        tmp_name = self._tmp_dir.name
        _write_fake_dat(tmp_name, "gA.dat", f"Technic Gear {tooth_a} Tooth Test")
        _write_fake_dat(tmp_name, "gB.dat", f"Technic Gear {tooth_b} Tooth Test")

        tm = TopologyManager()
        tm.add_part(_mk_part("frame"))
        # axle_a/axle_b 不需要 ldraw_id —— 不是齿轮
        tm.add_part(_mk_part("axle_a", world_pos=[0, 0, 0]))
        tm.add_part(_mk_part("axle_b", world_pos=[gap, 0, 0]))
        # 齿轮位姿继承自 axle（同一 fixed cluster 共位姿；这里 gear 与 axle 重合）
        tm.add_part(_mk_part("gear_a", ldraw_id="gA.dat", world_pos=[0, 0, 0]))
        tm.add_part(_mk_part("gear_b", ldraw_id="gB.dat", world_pos=[gap, 0, 0]))

        # frame ↔ axle_x 用 pin/peghole → continuous（模拟 axle 在 beam 圆孔中旋转）
        tm.connect_ports(ConnectionEdge(
            "frame", "axle_a",
            _mk_port("p", "pin", [0, 0, 0]),
            _mk_port("c", "peghole", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "frame", "axle_b",
            _mk_port("p", "pin", [0, 0, 0]),
            _mk_port("c", "peghole", [0, 0, 0]),
        ))
        # axle_x ↔ gear_x 用 axle/axlehole → fixed（齿轮锁在 axle 上）
        tm.connect_ports(ConnectionEdge(
            "axle_a", "gear_a",
            _mk_port("p", "axle", [0, 0, 0]),
            _mk_port("c", "axlehole", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "axle_b", "gear_b",
            _mk_port("p", "axle", [0, 0, 0]),
            _mk_port("c", "axlehole", [0, 0, 0]),
        ))

        tree = tm.build_spanning_tree()
        return tree, tm.closed_loops, tmp_name

    def _export(self, tree, loops, parts_dir) -> ET.Element:
        with TemporaryDirectory() as out_dir:
            out = os.path.join(out_dir, "out.urdf")
            URDFExporter(ldraw_parts_dir=parts_dir).export(tree, loops, out)
            return ET.parse(out).getroot()

    def test_mimic_lands_on_axle_spin_joint_not_gear_fixed_joint(self):
        """中介链：mimic 必须在 frame→axle_b 的 continuous joint 上，
        而不是 axle_b→gear_b 的 fixed joint 上。"""
        tree, loops, parts_dir = self._build_axle_mediated_chain(24, 24)
        root = self._export(tree, loops, parts_dir)

        joints_by_name = {j.get('name'): j for j in root.findall('joint')}
        # 齿轮自身的 fixed joint 不应有 mimic
        gear_b_fixed = joints_by_name.get('joint_axle_b_to_gear_b')
        self.assertIsNotNone(gear_b_fixed, "axle_b→gear_b 的 fixed joint 应存在")
        assert gear_b_fixed is not None
        self.assertEqual(gear_b_fixed.get('type'), 'fixed')
        self.assertIsNone(
            gear_b_fixed.find('mimic'),
            "fixed joint 不能加 <mimic>（URDF 规范不支持）",
        )

        # axle_b 的 spin joint 必须有 mimic 引用 axle_a 的 spin joint
        axle_b_spin = joints_by_name.get('joint_frame_to_axle_b')
        self.assertIsNotNone(axle_b_spin, "frame→axle_b 的 continuous spin joint 应存在")
        assert axle_b_spin is not None
        self.assertEqual(axle_b_spin.get('type'), 'continuous')
        mimic = axle_b_spin.find('mimic')
        self.assertIsNotNone(mimic, "axle 中介齿轮链 mimic 必须在 axle 的 spin joint 上")
        assert mimic is not None
        self.assertEqual(mimic.get('joint'), 'joint_frame_to_axle_a')
        self.assertAlmostEqual(float(mimic.get('multiplier', '0')), -1.0, places=4)

    def test_asymmetric_axle_mediated_chain_correct_multiplier(self):
        """12T → 24T 中介链：multiplier = -12/24 = -0.5。"""
        tree, loops, parts_dir = self._build_axle_mediated_chain(12, 24)
        root = self._export(tree, loops, parts_dir)
        joints = {j.get('name'): j for j in root.findall('joint')}
        axle_b_spin = joints.get('joint_frame_to_axle_b')
        assert axle_b_spin is not None
        mimic = axle_b_spin.find('mimic')
        assert mimic is not None
        self.assertAlmostEqual(float(mimic.get('multiplier', '0')), -0.5, places=4)

    def test_no_mimic_when_two_gears_on_same_axle(self):
        """同一 axle 上的两齿轮：同 fixed cluster，自然共转，不应写 mimic。"""
        self._tmp_dir = TemporaryDirectory()
        tmp_name = self._tmp_dir.name
        _write_fake_dat(tmp_name, "gA.dat", "Technic Gear 24 Tooth Test")
        _write_fake_dat(tmp_name, "gB.dat", "Technic Gear 24 Tooth Test")

        tm = TopologyManager()
        tm.add_part(_mk_part("frame"))
        tm.add_part(_mk_part("axle1", world_pos=[0, 0, 0]))
        # 两齿轮卡同一 axle 上，沿 +Z 错开（实际玩法：两个齿轮串在同一根长 axle）
        gap_along_axis = LEGO_GEAR_MODULE_M / 2  # 卡在轴向限位 module 内（共平面边界）
        tm.add_part(_mk_part("gear_a", ldraw_id="gA.dat", world_pos=[0, 0, 0]))
        tm.add_part(_mk_part("gear_b", ldraw_id="gB.dat", world_pos=[0, 0, gap_along_axis]))

        tm.connect_ports(ConnectionEdge(
            "frame", "axle1",
            _mk_port("p", "pin", [0, 0, 0]),
            _mk_port("c", "peghole", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "axle1", "gear_a",
            _mk_port("p", "axle", [0, 0, 0]),
            _mk_port("c", "axlehole", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "axle1", "gear_b",
            _mk_port("p", "axle", [0, 0, 0]),
            _mk_port("c", "axlehole", [0, 0, 0]),
        ))

        tree = tm.build_spanning_tree()
        root = self._export(tree, [], tmp_name)

        # 整个 spanning tree 内任何 joint 都不应含 mimic（同 cluster + 几何也不咬合）
        for joint in root.findall('joint'):
            self.assertIsNone(
                joint.find('mimic'),
                f"同 axle 多齿轮 cluster 内 joint {joint.get('name')!r} 不应有 mimic",
            )

    def test_no_mimic_when_gear_in_root_pinned_cluster(self):
        """spanning tree root 所在 cluster（无 incoming continuous joint）= 钉死状态，
        cluster 内齿轮既不能做 leader 也不能做 follower。"""
        self._tmp_dir = TemporaryDirectory()
        tmp_name = self._tmp_dir.name
        _write_fake_dat(tmp_name, "gA.dat", "Technic Gear 24 Tooth Test")
        _write_fake_dat(tmp_name, "gB.dat", "Technic Gear 24 Tooth Test")

        gap = 24 * LEGO_GEAR_MODULE_M  # 24+24 / 2 · module = 24·module
        tm = TopologyManager()
        # gear_root 直接 fixed 到 spanning tree root（frame）—— 同 root cluster 无 spin
        tm.add_part(_mk_part("frame"))
        tm.add_part(_mk_part("gear_root", ldraw_id="gA.dat", world_pos=[0, 0, 0]))
        # gear_b 在另一 axle 上正常的 continuous spin
        tm.add_part(_mk_part("axle_b", world_pos=[gap, 0, 0]))
        tm.add_part(_mk_part("gear_b", ldraw_id="gB.dat", world_pos=[gap, 0, 0]))

        # frame ↔ gear_root：axle/axlehole = fixed（齿轮直接钉在 frame 上）
        tm.connect_ports(ConnectionEdge(
            "frame", "gear_root",
            _mk_port("p", "axle", [0, 0, 0]),
            _mk_port("c", "axlehole", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "frame", "axle_b",
            _mk_port("p", "pin", [0, 0, 0]),
            _mk_port("c", "peghole", [0, 0, 0]),
        ))
        tm.connect_ports(ConnectionEdge(
            "axle_b", "gear_b",
            _mk_port("p", "axle", [0, 0, 0]),
            _mk_port("c", "axlehole", [0, 0, 0]),
        ))

        tree = tm.build_spanning_tree()
        root = self._export(tree, [], tmp_name)

        # gear_root 在 root cluster（无 spin）→ 它不能做 leader 也不能做 follower
        # gear_b 几何 mesh 但配对失败（leader cluster 没 spin joint）→ 整个 mimic 缺位
        for joint in root.findall('joint'):
            self.assertIsNone(
                joint.find('mimic'),
                f"root cluster 内齿轮跳过，joint {joint.get('name')!r} 不应有 mimic",
            )


def _rot_to_align_z(world_z) -> np.ndarray:
    """构造一个旋转矩阵：把局部 +Z 对齐到给定世界单位向量。"""
    target = np.array(world_z, dtype=float)
    target = target / np.linalg.norm(target)
    z = np.array([0.0, 0.0, 1.0])
    if np.allclose(target, z):
        return np.eye(3)
    if np.allclose(target, -z):
        return np.diag([1, -1, -1]).astype(float)
    axis = np.cross(z, target)
    axis = axis / np.linalg.norm(axis)
    angle = float(np.arccos(np.clip(np.dot(z, target), -1.0, 1.0)))
    # Rodrigues
    K = np.array([[0, -axis[2], axis[1]],
                  [axis[2], 0, -axis[0]],
                  [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * (K @ K)


if __name__ == "__main__":
    unittest.main()

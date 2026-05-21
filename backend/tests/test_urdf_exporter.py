"""
test_urdf_exporter.py
======================
覆盖 backend/urdf_exporter.py 的 L45 / L44b / L45b 改造：
  - 闭环边写 SDF 1.9 风格 <gazebo><joint>，不再用虚构 <plugin>
  - 齿轮对（轴线平行 + 中心距匹配）给 follower joint 生成 <mimic>
  - L44b 中介齿轮链：齿轮 axlehole 卡 axle 上（fixed）+ axle 在 beam 圆孔中
    spin（continuous），mimic 必须加在齿轮所在 cluster 的 effective spin joint 上
  - 退化场景：垂直轴 / 距离不匹配 / 共轴 / 缺 ldraw_parts_dir → 无 mimic
  - L44b 退化：同 axle 多齿轮（同 cluster）无 mimic；钉死 cluster 内齿轮跳过
  - L45b 4-bar fidelity：4 beam pin/peghole 闭环，砍掉的边必须仍 continuous（不
    退化 fixed，否则连杆机构变废铁）
  - L45b Floating Base：URDFExporter(floating_base=True) emit world link + 根
    floating joint；默认关保持向后兼容
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
from backend.urdf_exporter import (  # noqa: E402
    LEGO_GEAR_MODULE_M,
    URDFExporter,
    export_urdf,
    floating_base_for_mode,
)


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
        # 三 beam + 三 pin 连接，topology 解环后会有 1 条 closed_loop。
        # issue #49 修：parent_port 必须 MALE (pin) / child_port 必须 FEMALE
        # (peghole)，跟 derive_joint_params(plug=MALE, socket=FEMALE) 极性
        # 一致。原 fixture 三条边都反了 → derive 全退化 fixed →
        # closed_loop joint type fidelity 实际没验。
        self.tm = TopologyManager()
        self.tm.add_part(_mk_part("A"))
        self.tm.add_part(_mk_part("B"))
        self.tm.add_part(_mk_part("C"))
        self.tm.connect_ports(ConnectionEdge(
            "A", "B", _mk_port("p", "pin", [0, 0, 0]), _mk_port("c", "peghole", [0, 0, 0]),
        ))
        self.tm.connect_ports(ConnectionEdge(
            "B", "C", _mk_port("p", "pin", [0, 0, 0]), _mk_port("c", "peghole", [0, 0, 0]),
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
        # issue #49 收紧：pin↔peghole 极性正确 → derive_joint_params 应返
        # 'continuous'。原宽断言（type-in-set）让 fixture 三条边全退化
        # 成 fixed 也能过，没真验"BFS 砍点保留 joint type fidelity"。
        self.assertEqual(gj.get('type'), 'continuous')
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


# ─── L45b 4-bar 闭环 fidelity 测试 ─────────────────────────────────────────

class Test4BarLinkage(unittest.TestCase):
    """L45b：4-bar linkage 是 LEGO Technic 最常见的可动闭环机构。BFS 砍掉一条
    形成 spanning tree + 1 closed_loop 边。fidelity 关键：闭环边的 joint type
    必须从 port pair 推出来的真实类型 (continuous)，不能错误退化为 fixed —— 否则
    外部 simulator 把 4-bar 加载成刚体。

    端口顺序设计：parent_port 全用 MALE (pin)，child_port 全用 FEMALE (peghole)。
    derive_joint_params 要求 plug=MALE + socket=FEMALE 才返 continuous，反着写
    会因 INCOMPATIBLE 退化到 fixed —— 现有 TestClosedLoopExport 三角形 fixture
    端口顺序反着，所以那套测试只是"type in legal set" 的宽断言。本测试用正向顺
    序，对所有 4 条边强制 continuous，确保 BFS 砍哪条都 fidelity 不变。
    """

    def setUp(self) -> None:
        self.tm = TopologyManager()
        for nid in ('A', 'B', 'C', 'D'):
            self.tm.add_part(_mk_part(nid))
        # 4-bar: A → B → C → D → A
        # parent_port = pin (MALE), child_port = peghole (FEMALE) → continuous
        for parent, child in (('A', 'B'), ('B', 'C'), ('C', 'D'), ('D', 'A')):
            self.tm.connect_ports(ConnectionEdge(
                parent, child,
                _mk_port("p", "pin",     [0, 0, 0]),
                _mk_port("c", "peghole", [0, 0, 0]),
            ))

    def _export_and_parse(self) -> ET.Element:
        tree = self.tm.build_spanning_tree()
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter().export(tree, self.tm.closed_loops, out)
            return ET.parse(out).getroot()

    def test_4bar_yields_4_links_3_main_joints_1_closed_loop(self):
        root = self._export_and_parse()
        links = root.findall('link')
        # spanning tree 主 joints 在 robot 直接子节点；闭环走 <gazebo><joint>
        main_joints = root.findall('joint')
        gazebo_joints = root.findall('gazebo/joint')

        self.assertEqual(len(links), 4, "4-bar 应产生 4 个 link")
        self.assertEqual(len(main_joints), 3, "spanning tree 应剩 3 条主 joint")
        self.assertEqual(len(gazebo_joints), 1, "BFS 应砍 1 条边到 closed_loop")

    def test_4bar_closed_loop_joint_is_continuous_not_fixed(self):
        """关键 fidelity：闭环必须保留 continuous 类型，否则 4-bar 退化成刚体。"""
        root = self._export_and_parse()
        gj = root.find('gazebo/joint')
        self.assertIsNotNone(gj, "4-bar 应产生 1 个 closed_loop joint")
        assert gj is not None
        self.assertEqual(
            gj.get('type'), 'continuous',
            "4-bar 闭环 joint 必须是 continuous（pin/peghole = MALE+FEMALE+CYLINDER），"
            "如果退化为 fixed 则连杆机构变废铁。",
        )

    def test_4bar_main_joints_all_continuous(self):
        """spanning tree 内 3 条主 joint 也必须全 continuous。"""
        root = self._export_and_parse()
        for joint in root.findall('joint'):
            self.assertEqual(
                joint.get('type'), 'continuous',
                f"spanning tree joint {joint.get('name')!r} 应是 continuous（同源 pin/peghole）",
            )
            # continuous joint 必须有 <axis>
            self.assertIsNotNone(
                joint.find('axis'),
                f"continuous joint {joint.get('name')!r} 必须含 <axis>",
            )


# ─── L45b Floating Base 测试 ───────────────────────────────────────────────

class TestFloatingBase(unittest.TestCase):
    """L45b：URDFExporter(floating_base=True) 在主 link/joint 之前 emit
    <link name="world"/> + <joint type="floating" parent="world" child="$root"/>，
    让 ROS 2 / Gazebo 加载装配时整体 6DOF 浮空而非钉死。默认关保留向后兼容。"""

    def _build_simple_tree(self) -> tuple[nx.DiGraph, list]:
        """frame → A：单条 continuous joint，spanning tree root = frame（in_degree 0）。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("frame"))
        tm.add_part(_mk_part("A"))
        tm.connect_ports(ConnectionEdge(
            "frame", "A",
            _mk_port("p", "pin",     [0, 0, 0]),
            _mk_port("c", "peghole", [0, 0, 0]),
        ))
        tree = tm.build_spanning_tree()
        return tree, tm.closed_loops

    def _export(self, tree, loops, **exporter_kwargs) -> ET.Element:
        with TemporaryDirectory() as out_dir:
            out = os.path.join(out_dir, "out.urdf")
            URDFExporter(**exporter_kwargs).export(tree, loops, out)
            return ET.parse(out).getroot()

    def test_floating_base_disabled_by_default(self):
        """默认关 → URDF 不含 world link 也不含 floating joint，旧行为完全保留。"""
        tree, loops = self._build_simple_tree()
        root = self._export(tree, loops)
        link_names = [el.get('name') for el in root.findall('link')]
        self.assertNotIn('world', link_names, "默认关时 URDF 不应出现 world link")
        for joint in root.findall('joint'):
            self.assertNotEqual(
                joint.get('type'), 'floating',
                "默认关时不应出现 floating joint",
            )

    def test_floating_base_adds_world_link_and_floating_joint(self):
        """开关开 → URDF 含 world link + type=floating 的根 joint。"""
        tree, loops = self._build_simple_tree()
        root = self._export(tree, loops, floating_base=True)
        link_names = [el.get('name') for el in root.findall('link')]
        self.assertIn('world', link_names, "floating_base=True 必须 emit world link")

        floating_joints = [j for j in root.findall('joint') if j.get('type') == 'floating']
        self.assertEqual(
            len(floating_joints), 1,
            "floating_base=True 必须 emit 恰好 1 条 floating joint",
        )
        fj = floating_joints[0]
        self.assertEqual(fj.get('name'), 'root_floating')

    def test_floating_base_child_is_spanning_tree_root(self):
        """floating joint 的 parent=world，child = spanning tree 入度 0 节点。"""
        tree, loops = self._build_simple_tree()
        root = self._export(tree, loops, floating_base=True)
        fj = next(
            (j for j in root.findall('joint') if j.get('type') == 'floating'), None,
        )
        assert fj is not None
        parent_el = fj.find('parent')
        child_el  = fj.find('child')
        self.assertIsNotNone(parent_el)
        self.assertIsNotNone(child_el)
        assert parent_el is not None and child_el is not None  # mypy
        self.assertEqual(parent_el.get('link'), 'world')
        # spanning tree root = frame（_build_simple_tree 中 in_degree 0 节点）
        self.assertEqual(child_el.get('link'), 'frame')

    def test_floating_base_world_link_precedes_root_link_in_xml(self):
        """URDF spec 要求引用前定义：world link 必须在 robot 直接子节点中
        位于 spanning tree 主 link 之前。"""
        tree, loops = self._build_simple_tree()
        root = self._export(tree, loops, floating_base=True)
        # 收集 robot 直接子节点中所有 <link> 的 name 顺序
        link_names_in_order = [
            el.get('name') for el in root if el.tag == 'link'
        ]
        self.assertEqual(
            link_names_in_order[0], 'world',
            "world link 必须是 URDF 中的第一个 link",
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


class TestExportEdgeCases(unittest.TestCase):
    """export() 主流程边界 case：空树 / 单 link / 多 root / robot_name /
    link 子元素完整性 / fixed vs continuous joint 字段。

    audit 报告称"XML 树构造无单测"是 false positive (Mimic / Floating Base
    已被 18 case 覆盖)，但 export 入口的边界条件确实漏 — 本组补 8 case。
    """

    def _export_to_root(
        self, tree: nx.DiGraph, loops, **exporter_kwargs
    ) -> ET.Element:
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter(**exporter_kwargs).export(
                tree, loops, out, **(exporter_kwargs.get("export_kwargs", {})),
            )
            return ET.parse(out).getroot()

    def test_empty_tree_writes_robot_with_no_links(self):
        """空 graph：URDF 仍是合法 <robot>，只是无 link/joint。"""
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "empty.urdf")
            URDFExporter().export(nx.DiGraph(), [], out)
            root = ET.parse(out).getroot()
        self.assertEqual(root.tag, "robot")
        self.assertEqual(len(root.findall("link")), 0)
        self.assertEqual(len(root.findall("joint")), 0)

    def test_no_closed_loops_no_gazebo_block(self):
        """closed_loops=[] → URDF 不应 emit <gazebo> 块。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("A"))
        tm.add_part(_mk_part("B"))
        tm.connect_ports(ConnectionEdge(
            "A", "B",
            _mk_port("p", "peghole", [0, 0, 0]),
            _mk_port("c", "pin", [0, 0, 0]),
        ))
        tree = tm.build_spanning_tree()
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter().export(tree, tm.closed_loops, out)
            root = ET.parse(out).getroot()
        self.assertEqual(len(root.findall("gazebo")), 0)

    def test_single_part_one_link_no_joints(self):
        """单零件 graph：1 link，0 joint。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("solo"))
        tree = tm.build_spanning_tree()
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter().export(tree, [], out)
            root = ET.parse(out).getroot()
        links = root.findall("link")
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0].get("name"), "solo")
        self.assertEqual(len(root.findall("joint")), 0)

    def test_link_has_inertial_visual_collision(self):
        """每个 <link> 应同时含 inertial / visual / collision 三个子元素。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("L"))
        tree = tm.build_spanning_tree()
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter().export(tree, [], out)
            root = ET.parse(out).getroot()
        link = root.find("link")
        assert link is not None
        self.assertIsNotNone(link.find("inertial"))
        self.assertIsNotNone(link.find("visual"))
        self.assertIsNotNone(link.find("collision"))
        # inertial 子结构
        inertial = link.find("inertial")
        assert inertial is not None
        self.assertIsNotNone(inertial.find("mass"))
        self.assertIsNotNone(inertial.find("inertia"))

    def test_robot_name_custom(self):
        """robot_name 参数生效，作为 <robot name=...> 顶层属性。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("X"))
        tree = tm.build_spanning_tree()
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter().export(tree, [], out, robot_name="my_lego_thing")
            root = ET.parse(out).getroot()
        self.assertEqual(root.get("name"), "my_lego_thing")

    def test_floating_base_multi_root_skipped_no_world_link(self):
        """spanning tree 多于一个入度 0 节点 → floating_base=True 也不 emit
        world link（避免选错 root）。"""
        # 强造一个 disconnected 双 root 图
        tree = nx.DiGraph()
        tree.add_node("R1", data=_mk_part("R1"))
        tree.add_node("R2", data=_mk_part("R2"))
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter(floating_base=True).export(tree, [], out)
            root = ET.parse(out).getroot()
        link_names = [el.get("name") for el in root.findall("link")]
        self.assertNotIn("world", link_names)
        # 也不应有 floating joint
        floating_joints = [
            j for j in root.findall("joint") if j.get("type") == "floating"
        ]
        self.assertEqual(len(floating_joints), 0)

    def test_continuous_joint_has_axis_and_dynamics(self):
        """非 fixed joint 应含 <axis> + <dynamics> 子元素。"""
        # pin/peghole → derive_joint 给 continuous（旋转销）
        tm = TopologyManager()
        tm.add_part(_mk_part("p"))
        tm.add_part(_mk_part("h"))
        tm.connect_ports(ConnectionEdge(
            "p", "h",
            _mk_port("a", "pin", [0, 0, 0]),
            _mk_port("b", "peghole", [0, 0, 0]),
        ))
        tree = tm.build_spanning_tree()
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter().export(tree, [], out)
            root = ET.parse(out).getroot()
        joints = [j for j in root.findall("joint") if j.get("type") != "fixed"]
        self.assertGreater(len(joints), 0, "至少应有 1 个非 fixed joint")
        for joint in joints:
            self.assertIsNotNone(joint.find("axis"), "非 fixed joint 应有 <axis>")
            self.assertIsNotNone(
                joint.find("dynamics"), "非 fixed joint 应有 <dynamics>"
            )

    def test_export_writes_valid_xml_to_disk(self):
        """端到端 sanity：写出文件可被 ET.parse 重新读回（XML 合法 / 未截断）。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("A"))
        tm.add_part(_mk_part("B"))
        tm.connect_ports(ConnectionEdge(
            "A", "B",
            _mk_port("p", "peghole", [0, 0, 0]),
            _mk_port("c", "pin", [0, 0, 0]),
        ))
        tree = tm.build_spanning_tree()
        with TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.urdf")
            URDFExporter().export(tree, [], out)
            self.assertTrue(os.path.isfile(out))
            with open(out, "r", encoding="utf-8") as f:
                content = f.read()
            # 写出格式 minidom prettyxml，第一行应是 XML 声明
            self.assertTrue(content.startswith("<?xml"))
            # 端到端 reparse 不抛
            ET.parse(out)


class TestModeAwareFloatingBase(unittest.TestCase):
    """issue #51：mode → floating_base 接通。

    floating_base_for_mode 纯函数 + 经 module-level export_urdf（server.toggle_mode
    实际调 topology_manager.export_urdf → 同一 exporter 入口）端到端验：
    SIMULATION 导出含 world link，ASSEMBLY 不含。补齐 server 层 wiring 的回归，
    与 TestFloatingBase（exporter 内部行为）互补。
    """

    def _build_simple_tree(self):
        tm = TopologyManager()
        tm.add_part(_mk_part("frame"))
        tm.add_part(_mk_part("A"))
        tm.connect_ports(ConnectionEdge(
            "frame", "A",
            _mk_port("p", "pin",     [0, 0, 0]),
            _mk_port("c", "peghole", [0, 0, 0]),
        ))
        return tm.build_spanning_tree(), tm.closed_loops

    # ── 纯函数 floating_base_for_mode ────────────────────────────────────────

    def test_simulation_mode_floats(self):
        self.assertTrue(floating_base_for_mode("SIMULATION"))

    def test_assembly_mode_pinned(self):
        self.assertFalse(floating_base_for_mode("ASSEMBLY"))

    def test_case_insensitive_and_whitespace(self):
        self.assertTrue(floating_base_for_mode("  simulation "))
        self.assertFalse(floating_base_for_mode("Assembly"))

    def test_unknown_mode_defaults_pinned(self):
        # 未知 mode 保守钉死（贴合装配主场景）
        self.assertFalse(floating_base_for_mode("WHATEVER"))
        self.assertFalse(floating_base_for_mode(""))

    # ── 集成冒烟：经 export_urdf 入口，URDF 头按 mode 差异 ───────────────────

    def test_simulation_export_emits_world_link(self):
        """mode=SIMULATION → export_urdf(floating_base=True) → URDF 含 world link。"""
        tree, loops = self._build_simple_tree()
        with TemporaryDirectory() as out_dir:
            out = os.path.join(out_dir, "sim.urdf")
            export_urdf(
                tree, loops, out,
                floating_base=floating_base_for_mode("SIMULATION"),
            )
            root = ET.parse(out).getroot()
        link_names = [el.get("name") for el in root.findall("link")]
        self.assertIn("world", link_names,
                      "SIMULATION 导出应含 world link（6DOF 浮空）")
        floating = [j for j in root.findall("joint") if j.get("type") == "floating"]
        self.assertEqual(len(floating), 1, "SIMULATION 应恰好 1 条 floating 根 joint")

    def test_assembly_export_omits_world_link(self):
        """mode=ASSEMBLY → export_urdf(floating_base=False) → URDF 不含 world link。"""
        tree, loops = self._build_simple_tree()
        with TemporaryDirectory() as out_dir:
            out = os.path.join(out_dir, "asm.urdf")
            export_urdf(
                tree, loops, out,
                floating_base=floating_base_for_mode("ASSEMBLY"),
            )
            root = ET.parse(out).getroot()
        link_names = [el.get("name") for el in root.findall("link")]
        self.assertNotIn("world", link_names,
                         "ASSEMBLY 导出应钉死，不含 world link")
        for joint in root.findall("joint"):
            self.assertNotEqual(joint.get("type"), "floating",
                                "ASSEMBLY 不应出现 floating joint")


if __name__ == "__main__":
    unittest.main()

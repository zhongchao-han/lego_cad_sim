"""
tests/test_insertion.py
=======================
装配体层级的插入生命周期测试。

设计理念（来自 docs/assembly_hierarchy_design.md §3）：
  无需 3D 渲染、无需物理引擎的纯业务逻辑测试。
  仅通过 Port / Part / ConnectionEdge / Assembly 对象验证系统健壮性。

涵盖场景：
  1. 长插销插入乐高梁孔的完整生命周期
  2. 装配体零件注册与连接校验
  3. JointState（插入深度）的实时修改
  4. 过约束检测与 Fixed Joint 降级
  5. 不兼容接口被正确拒绝
  6. resolve_kinematics 生成树与闭环检测
  7. URDFExporter 能生成合法 XML
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest

from connection_interface import (
    ConnectionInterface, Gender, Profile, FitType, LDU,
)
from port import Port
from part import Part
from connection_edge import ConnectionEdge, JointState
from assembly import Assembly
from urdf_exporter import URDFExporter


# ---------------------------------------------------------------------------
# 辅助构造器
# ---------------------------------------------------------------------------

def make_hole_port(name="h", pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback(name, "peghole.dat", np.array(pos, dtype=float), np.eye(3))


def make_pin_port(name="p", pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback(name, "pin.dat", np.array(pos, dtype=float), np.eye(3))


def make_fric_pin_port(name="fp", pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback(name, "fric_pin.dat", np.array(pos, dtype=float), np.eye(3))


def make_axle_port(name="ax", pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback(name, "axle.dat", np.array(pos, dtype=float), np.eye(3))


def make_axlehole_port(name="ah", pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback(name, "axlehole.dat", np.array(pos, dtype=float), np.eye(3))


# ---------------------------------------------------------------------------
# 1. 长插销插入乐高梁孔的完整生命周期
# ---------------------------------------------------------------------------

class TestLongPinInsertionLifecycle:
    """
    场景：一根长插销（pin）插入一根 3 孔梁（beam）的中央孔。
    对应 docs/assembly_hierarchy_design.md §3 的"讲故事"测试。
    """

    def setup_method(self):
        """每个测试前重建零件和装配体。"""
        # 创建长插销零件（pin.dat：直径 < 孔，间隙配合）
        self.pin_part = Part("pin_001", "long_pin")
        self.pin_part.add_port(make_pin_port("p_left",  pos=(0.0, 0.0,  0.0)))
        self.pin_part.add_port(make_pin_port("p_right", pos=(0.0, 0.016, 0.0)))

        # 创建 3 孔梁零件
        self.beam = Part("beam_001", "3_hole_beam")
        self.beam.add_port(make_hole_port("h_left",   pos=(0.0, 0.0, 0.0)))
        self.beam.add_port(make_hole_port("h_center", pos=(0.008, 0.0, 0.0)))
        self.beam.add_port(make_hole_port("h_right",  pos=(0.016, 0.0, 0.0)))

        self.asm = Assembly("pin_beam_asm")
        self.asm.add_part(self.pin_part)
        self.asm.add_part(self.beam)

    def test_parts_registered_in_assembly(self):
        assert "pin_001" in self.asm.parts
        assert "beam_001" in self.asm.parts
        assert len(self.asm.parts) == 2

    def test_pin_fits_hole_clearance(self):
        """普通销：应为间隙配合（可自由旋转）。"""
        pin_port  = make_pin_port()
        hole_port = make_hole_port()
        assert pin_port.test_fit_with(hole_port) == FitType.CLEARANCE

    def test_pin_gives_continuous_joint(self):
        """间隙配合应推导出 continuous 关节。"""
        pin_port  = make_pin_port()
        hole_port = make_hole_port()
        jtype, damp, _ = pin_port.derive_joint(hole_port)
        assert jtype == "continuous"
        assert damp == pytest.approx(0.05)

    def test_connect_pin_to_beam_center_hole(self):
        """销钉与梁孔连接——验证 ConnectionEdge 被正确添加到装配体。"""
        edge = ConnectionEdge(
            "pin_001", "beam_001",
            make_pin_port("p_left"),
            make_hole_port("h_center"),
        )
        self.asm.connect_ports(edge)
        assert len(self.asm.connections) == 1

    def test_insertion_depth_defaults_to_zero(self):
        """JointState 默认插入深度为 0（完全插到底）。"""
        edge = ConnectionEdge("pin_001", "beam_001", make_pin_port(), make_hole_port())
        assert edge.state.insertion_depth == pytest.approx(0.0)

    def test_insertion_depth_modifiable(self):
        """JointState.insertion_depth 可以在运行时修改（拖拽动画核心）。"""
        edge = ConnectionEdge("pin_001", "beam_001", make_pin_port(), make_hole_port())
        edge.state.insertion_depth = 0.004  # 插入 4mm
        assert edge.state.insertion_depth == pytest.approx(0.004)

    def test_relative_transform_changes_with_depth(self):
        """不同插入深度应产生不同的变换矩阵（沿 Z 轴平移）。"""
        pin_port  = make_pin_port("p", pos=(0.0, 0.0, 0.0))
        hole_port = make_hole_port("h", pos=(0.0, 0.0, 0.0))

        edge = ConnectionEdge("pin_001", "beam_001", pin_port, hole_port)

        T0 = edge.get_relative_transform()
        edge.state.insertion_depth = 0.004
        T1 = edge.get_relative_transform()

        # 平移向量应不同
        assert not np.allclose(T0[:3, 3], T1[:3, 3], atol=1e-9)

    def test_resolve_kinematics_single_connection(self):
        """单条连接 → 生成树有 2 节点、1 边、0 闭环。"""
        edge = ConnectionEdge(
            "pin_001", "beam_001",
            make_pin_port("p"), make_hole_port("h"),
        )
        self.asm.connect_ports(edge)

        tree = self.asm.resolve_kinematics()
        assert tree.number_of_nodes() == 2
        assert tree.number_of_edges() == 1
        assert len(self.asm.closed_loops) == 0


# ---------------------------------------------------------------------------
# 2. 物理校验：不兼容接口被拒绝
# ---------------------------------------------------------------------------

class TestPhysicalCompatibilityGuard:

    def test_hole_to_hole_incompatible(self):
        """孔 ↔ 孔：极性相同，应为 INCOMPATIBLE。"""
        edge = ConnectionEdge(
            "A", "B",
            make_hole_port("h1"), make_hole_port("h2"),
        )
        assert edge.is_physically_compatible() is False

    def test_connect_incompatible_raises_value_error(self):
        """不兼容接口的连接请求应抛出 ValueError。"""
        asm = Assembly("guard_asm")
        asm.add_part(Part("A", "beam"))
        asm.add_part(Part("B", "beam"))

        bad_edge = ConnectionEdge(
            "A", "B",
            make_hole_port("h1"), make_hole_port("h2"),
        )
        with pytest.raises(ValueError, match="Physical constraints"):
            asm.connect_ports(bad_edge)

    def test_unregistered_part_raises_value_error(self):
        """连接未注册零件应抛出 ValueError。"""
        asm = Assembly("guard_asm")
        asm.add_part(Part("A", "beam"))

        edge = ConnectionEdge("A", "GHOST", make_pin_port(), make_hole_port())
        with pytest.raises(ValueError, match="GHOST"):
            asm.connect_ports(edge)

    def test_blocked_pin_too_large(self):
        """销半径远大于孔时，is_physically_compatible() 为 False。"""
        big_iface = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 20.0 * LDU, 40.0 * LDU)
        big_pin   = Port("big_p", big_iface, np.zeros(3), np.eye(3))
        hole      = make_hole_port()
        edge      = ConnectionEdge("X", "Y", big_pin, hole)
        assert edge.is_physically_compatible() is False

    def test_cross_profile_mismatch(self):
        """十字轴插圆孔应被拒绝（截面不匹配）。"""
        edge = ConnectionEdge("X", "Y", make_axle_port(), make_hole_port())
        assert edge.is_physically_compatible() is False


# ---------------------------------------------------------------------------
# 3. 摩擦销
# ---------------------------------------------------------------------------

class TestFrictionPin:

    def test_friction_pin_fits(self):
        fric = make_fric_pin_port()
        hole = make_hole_port()
        assert fric.test_fit_with(hole) == FitType.FRICTION

    def test_friction_pin_is_compatible(self):
        edge = ConnectionEdge("A", "B", make_fric_pin_port(), make_hole_port())
        assert edge.is_physically_compatible() is True

    def test_friction_pin_gives_high_damping(self):
        jtype, damp, _ = make_fric_pin_port().derive_joint(make_hole_port())
        assert jtype == "continuous"
        assert damp == pytest.approx(1.5)


# ---------------------------------------------------------------------------
# 4. 十字轴与轴孔
# ---------------------------------------------------------------------------

class TestAxleAndAxleHole:

    def test_axle_to_axle_hole_compatible(self):
        edge = ConnectionEdge("A", "B", make_axle_port(), make_axlehole_port())
        assert edge.is_physically_compatible() is True

    def test_axle_gives_fixed_joint(self):
        jtype, _, _ = make_axle_port().derive_joint(make_axlehole_port())
        assert jtype == "fixed"


# ---------------------------------------------------------------------------
# 5. 过约束检测（多销连接同一对零件 → Fixed Joint）
# ---------------------------------------------------------------------------

class TestOverconstraint:

    def setup_method(self):
        self.asm = Assembly("oc_asm")
        self.asm.add_part(Part("A", "beam"))
        self.asm.add_part(Part("B", "beam"))

    def test_two_pins_between_same_parts_merges_to_fixed(self):
        """同一对零件间两条连接边 → is_merged=True。"""
        e1 = ConnectionEdge("A", "B",
                            make_pin_port("p1", pos=(0.0, 0.0, 0.0)),
                            make_hole_port("h1", pos=(0.0, 0.0, 0.0)))
        e2 = ConnectionEdge("A", "B",
                            make_pin_port("p2", pos=(0.008, 0.0, 0.0)),
                            make_hole_port("h2", pos=(0.008, 0.0, 0.0)))

        self.asm.connect_ports(e1)
        self.asm.connect_ports(e2)

        tree = self.asm.resolve_kinematics()

        # 生成树里 A→B 只有一条边，且 is_merged=True
        assert tree.has_edge("A", "B")
        edge_data: ConnectionEdge = tree.get_edge_data("A", "B")['data']
        assert edge_data.is_merged is True

    def test_overconstrained_edge_gives_fixed_joint(self):
        """过约束边的关节应降级为 fixed。"""
        e1 = ConnectionEdge("A", "B", make_pin_port("p1"), make_hole_port("h1"))
        e2 = ConnectionEdge("A", "B",
                            make_pin_port("p2", pos=(0.008, 0.0, 0.0)),
                            make_hole_port("h2", pos=(0.008, 0.0, 0.0)))
        self.asm.connect_ports(e1)
        self.asm.connect_ports(e2)

        tree = self.asm.resolve_kinematics()
        edge_data: ConnectionEdge = tree.get_edge_data("A", "B")['data']
        jtype, _, _ = edge_data.port_parent.derive_joint(edge_data.port_child,
                                                          edge_data.is_merged)
        assert jtype == "fixed"


# ---------------------------------------------------------------------------
# 6. 闭环检测
# ---------------------------------------------------------------------------

class TestClosedLoopDetection:

    def test_triangle_closes_loop(self):
        """A → B → C → A 形成闭环，闭环边应被打断并存入 closed_loops。"""
        asm = Assembly("loop_asm")
        for pid in ("A", "B", "C"):
            asm.add_part(Part(pid, f"beam_{pid}"))

        asm.connect_ports(ConnectionEdge("A", "B", make_pin_port("p1"), make_hole_port("h1")))
        asm.connect_ports(ConnectionEdge("B", "C", make_pin_port("p2"), make_hole_port("h2")))
        asm.connect_ports(ConnectionEdge("C", "A", make_pin_port("p3"), make_hole_port("h3")))

        tree = asm.resolve_kinematics()

        # 树：3 节点 2 边；闭环：1 条
        assert tree.number_of_nodes() == 3
        assert tree.number_of_edges() == 2
        assert len(asm.closed_loops) == 1


# ---------------------------------------------------------------------------
# 7. Part 几何计算
# ---------------------------------------------------------------------------

class TestPartGeometry:

    def test_port_global_transform_follows_part_transform(self):
        """零件平移后，端口全局位置应随之偏移。"""
        beam = Part("B", "beam")
        beam.add_port(make_hole_port("h", pos=(0.008, 0.0, 0.0)))

        beam.transform[0, 3] = 0.016  # X 方向平移 16mm
        pos = beam.get_port_global_position("h")
        np.testing.assert_allclose(pos, [0.016 + 0.008, 0.0, 0.0], atol=1e-9)

    def test_port_not_found_raises_key_error(self):
        beam = Part("B", "beam")
        with pytest.raises(KeyError):
            beam.get_port_global_transform("nonexistent")

    def test_insertion_axis_preserved_through_part(self):
        """端口的插入轴在全局坐标系下应由零件旋转矩阵正确变换。"""
        beam = Part("B", "beam")
        beam.add_port(make_hole_port("h"))  # LDraw +Y → Z = [0, 1, 0]

        # 零件绕 Z 轴旋转 90°
        Rz90 = np.array([[0, -1, 0, 0],
                         [1,  0, 0, 0],
                         [0,  0, 1, 0],
                         [0,  0, 0, 1]], dtype=float)
        beam.transform = Rz90
        axis = beam.get_port_global_insertion_axis("h")
        # [0,1,0] 经 Rz90 → [-1,0,0]
        np.testing.assert_allclose(axis, [-1, 0, 0], atol=1e-9)


# ---------------------------------------------------------------------------
# 8. URDFExporter 集成烟雾测试
# ---------------------------------------------------------------------------

class TestURDFExporter:

    def test_export_produces_valid_xml(self, tmp_path):
        """URDFExporter 应能为两零件的简单装配体生成可读取的 XML。"""
        from topology_manager import PartNode

        asm = Assembly("urdf_test")
        asm.add_part(Part("A", "beam_A"))
        asm.add_part(Part("B", "beam_B"))
        asm.connect_ports(ConnectionEdge(
            "A", "B",
            make_pin_port("p"), make_hole_port("h"),
        ))

        # 将 asm.parts 注入成 PartNode（URDF 导出使用 inertia / visual_mesh 等属性）
        from topology_manager import TopologyManager
        tm = TopologyManager()
        for pid, part in asm.parts.items():
            tm.add_part(PartNode(part_id=pid, name=part.name, mass=part.mass))
        for edge in asm.connections:
            tm.connect_ports(edge)

        tree = tm.build_spanning_tree()
        out  = str(tmp_path / "test.urdf")
        tm.export_urdf(tree, out)

        import xml.etree.ElementTree as ET
        root = ET.parse(out).getroot()
        assert root.tag == "robot"
        link_names = [l.get("name") for l in root.findall("link")]
        assert "A" in link_names and "B" in link_names
        joints = root.findall("joint")
        assert len(joints) == 1

    def test_exporter_direct_call(self, tmp_path):
        """直接调用 URDFExporter.export() 也应工作正常。"""
        import networkx as nx
        from topology_manager import PartNode

        tree = nx.DiGraph()
        pn_a = PartNode("A", "beam_A")
        pn_b = PartNode("B", "beam_B")
        tree.add_node("A", data=pn_a)
        tree.add_node("B", data=pn_b)

        edge = ConnectionEdge("A", "B", make_pin_port("p"), make_hole_port("h"))
        tree.add_edge("A", "B", data=edge)

        out = str(tmp_path / "direct.urdf")
        URDFExporter().export(tree, [], out)

        import xml.etree.ElementTree as ET
        root = ET.parse(out).getroot()
        assert root.tag == "robot"


# ---------------------------------------------------------------------------
# 命令行直接运行
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import subprocess
    result = subprocess.run(
        ["python", "-m", "pytest", __file__, "-v"],
        cwd=os.path.join(os.path.dirname(__file__), ".."),
    )
    sys.exit(result.returncode)

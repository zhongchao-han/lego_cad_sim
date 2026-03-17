"""
tests/test_connection_edge.py
==============================
ConnectionEdge 与 JointState 的独立单元测试。

设计理念：
  ConnectionEdge 是装配体的"边"——持有两端 Port、委托物理校验与几何
  计算、独立维护运行时状态（JointState）。
  这里专注测试边本身的行为，不依赖 Assembly 或渲染层。

测试覆盖：
  1. JointState 默认值与运行时修改
  2. is_physically_compatible —— 兼容/不兼容/过大/截面不匹配
  3. get_relative_transform —— 深度变化对平移的影响
  4. is_merged 标志管理
  5. __repr__ 输出格式
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
from connection_edge import ConnectionEdge, JointState


# ---------------------------------------------------------------------------
# 辅助构造器
# ---------------------------------------------------------------------------

def make_hole(pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback("h", "peghole.dat", np.array(pos, dtype=float), np.eye(3))


def make_pin(pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback("p", "pin.dat", np.array(pos, dtype=float), np.eye(3))


def make_fric_pin(pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback("fp", "fric_pin.dat", np.array(pos, dtype=float), np.eye(3))


def make_axle(pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback("ax", "axle.dat", np.array(pos, dtype=float), np.eye(3))


def make_axlehole(pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback("ah", "axlehole.dat", np.array(pos, dtype=float), np.eye(3))


def make_edge(parent_type="pin", child_type="peghole",
              parent_pos=(0.0, 0.0, 0.0), child_pos=(0.0, 0.0, 0.0)) -> ConnectionEdge:
    factories = {
        "pin": make_pin, "peghole": make_hole,
        "fric_pin": make_fric_pin, "axle": make_axle, "axlehole": make_axlehole,
    }
    pp = factories[parent_type](parent_pos)
    pc = factories[child_type](child_pos)
    return ConnectionEdge("A", "B", pp, pc)


# ---------------------------------------------------------------------------
# 1. JointState — 默认值与运行时修改
# ---------------------------------------------------------------------------

class TestJointState:

    def test_default_insertion_depth_is_zero(self):
        state = JointState()
        assert state.insertion_depth == pytest.approx(0.0)

    def test_default_rotation_angle_is_zero(self):
        state = JointState()
        assert state.rotation_angle == pytest.approx(0.0)

    def test_insertion_depth_mutable(self):
        state = JointState()
        state.insertion_depth = 0.004
        assert state.insertion_depth == pytest.approx(0.004)

    def test_rotation_angle_mutable(self):
        state = JointState()
        state.rotation_angle = 1.57
        assert state.rotation_angle == pytest.approx(1.57)

    def test_joint_state_explicit_init(self):
        state = JointState(insertion_depth=0.002, rotation_angle=0.785)
        assert state.insertion_depth == pytest.approx(0.002)
        assert state.rotation_angle == pytest.approx(0.785)

    def test_joint_state_is_independent_per_edge(self):
        """不同连接边的 JointState 应彼此独立，修改一个不影响另一个。"""
        e1 = make_edge()
        e2 = make_edge()
        e1.state.insertion_depth = 0.005
        assert e2.state.insertion_depth == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# 2. is_physically_compatible — 物理校验
# ---------------------------------------------------------------------------

class TestPhysicalCompatibility:

    def test_pin_to_hole_compatible(self):
        edge = make_edge("pin", "peghole")
        assert edge.is_physically_compatible() is True

    def test_friction_pin_to_hole_compatible(self):
        edge = make_edge("fric_pin", "peghole")
        assert edge.is_physically_compatible() is True

    def test_axle_to_axlehole_compatible(self):
        edge = make_edge("axle", "axlehole")
        assert edge.is_physically_compatible() is True

    def test_hole_to_hole_incompatible(self):
        """同性别端口：INCOMPATIBLE"""
        edge = ConnectionEdge("A", "B", make_hole(), make_hole())
        assert edge.is_physically_compatible() is False

    def test_pin_to_pin_incompatible(self):
        edge = ConnectionEdge("A", "B", make_pin(), make_pin())
        assert edge.is_physically_compatible() is False

    def test_axle_to_hole_profile_mismatch(self):
        """截面不匹配（CROSS vs CYLINDER）：INCOMPATIBLE"""
        edge = ConnectionEdge("A", "B", make_axle(), make_hole())
        assert edge.is_physically_compatible() is False

    def test_oversized_pin_blocked(self):
        """销半径远大于孔（BLOCKED），不兼容"""
        big_iface = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 20.0 * LDU, 40.0 * LDU)
        big_pin = Port("big_p", big_iface, np.zeros(3), np.eye(3))
        edge = ConnectionEdge("A", "B", big_pin, make_hole())
        assert edge.is_physically_compatible() is False


# ---------------------------------------------------------------------------
# 3. get_relative_transform — 深度与几何
# ---------------------------------------------------------------------------

class TestRelativeTransform:

    def test_returns_4x4_matrix(self):
        edge = make_edge()
        T = edge.get_relative_transform()
        assert T.shape == (4, 4)

    def test_depth_zero_is_default(self):
        """默认深度 0 的变换应与手动传 depth=0 的结果一致。"""
        pin_port  = make_pin()
        hole_port = make_hole()
        edge = ConnectionEdge("A", "B", pin_port, hole_port)
        T_via_edge = edge.get_relative_transform()
        T_direct   = pin_port.calculate_relative_transform(hole_port, depth=0.0)
        np.testing.assert_allclose(T_via_edge, T_direct, atol=1e-12)

    def test_different_depths_give_different_translations(self):
        """修改 insertion_depth 应改变平移分量。"""
        edge = make_edge()
        T0 = edge.get_relative_transform().copy()

        edge.state.insertion_depth = 0.004
        T1 = edge.get_relative_transform()

        assert not np.allclose(T0[:3, 3], T1[:3, 3], atol=1e-9)

    def test_depth_translates_along_insertion_axis(self):
        """
        depth=d 时的完整平移量推导：
          T_rel = T_self @ T_flip @ T_depth @ inv(T_other)
        所有位置为原点时，平移 = T_self.R @ T_flip.R @ [0,0,d]
        = pin_rotation @ _R_FLIP_Z @ [0,0,d]
        """
        from port import _R_FLIP_Z

        pin_port  = make_pin()   # rotation = _Rx_POS90 after normalization
        hole_port = make_hole()
        edge = ConnectionEdge("A", "B", pin_port, hole_port)

        depth = 0.005
        edge.state.insertion_depth = depth
        T_d = edge.get_relative_transform()

        # 使用实际旋转矩阵推导期望平移
        expected_t = pin_port.rotation @ _R_FLIP_Z @ np.array([0.0, 0.0, depth])
        np.testing.assert_allclose(T_d[:3, 3], expected_t, atol=1e-9)

    def test_rotation_part_is_orthogonal(self):
        """变换矩阵旋转部分必须是正交矩阵（保证刚体变换有效性）。"""
        edge = make_edge()
        R = edge.get_relative_transform()[:3, :3]
        np.testing.assert_allclose(R @ R.T, np.eye(3), atol=1e-9)
        assert abs(np.linalg.det(R) - 1.0) < 1e-9


# ---------------------------------------------------------------------------
# 4. is_merged 标志
# ---------------------------------------------------------------------------

class TestIsMerged:

    def test_default_is_not_merged(self):
        edge = make_edge()
        assert edge.is_merged is False

    def test_set_merged_affects_joint_type(self):
        """is_merged=True 时 derive_joint 应返回 fixed（过约束降级）。"""
        edge = make_edge()
        edge.is_merged = True
        jtype, _, _ = edge.port_parent.derive_joint(edge.port_child, is_overconstrained=True)
        assert jtype == "fixed"

    def test_unmerged_pin_hole_gives_continuous(self):
        """未合并的普通销连接应给出 continuous 关节。"""
        edge = make_edge()
        jtype, _, _ = edge.port_parent.derive_joint(edge.port_child, edge.is_merged)
        assert jtype == "continuous"

    def test_merged_friction_pin_also_fixed(self):
        """摩擦销若被合并，也应降级为 fixed。"""
        edge = make_edge("fric_pin", "peghole")
        edge.is_merged = True
        jtype, _, _ = edge.port_parent.derive_joint(edge.port_child, is_overconstrained=True)
        assert jtype == "fixed"


# ---------------------------------------------------------------------------
# 5. repr
# ---------------------------------------------------------------------------

class TestRepr:

    def test_repr_contains_parent_and_child_ids(self):
        edge = make_edge()
        r = repr(edge)
        assert "A" in r
        assert "B" in r

    def test_repr_shows_merged_false_by_default(self):
        edge = make_edge()
        assert "merged=False" in repr(edge)

    def test_repr_shows_merged_true_when_set(self):
        edge = make_edge()
        edge.is_merged = True
        assert "merged=True" in repr(edge)

    def test_repr_shows_depth(self):
        edge = make_edge()
        edge.state.insertion_depth = 0.003
        r = repr(edge)
        assert "0.0030" in r


# ---------------------------------------------------------------------------
# 6. 端口偏移对几何的影响
# ---------------------------------------------------------------------------

class TestPortOffsetGeometry:

    def test_offset_parent_port_shifts_transform_translation(self):
        """父端口位置偏移应反映在相对变换的平移分量中。"""
        pin_at_origin = make_pin(pos=(0.0, 0.0, 0.0))
        pin_offset    = make_pin(pos=(0.008, 0.0, 0.0))
        hole          = make_hole()

        e_origin = ConnectionEdge("A", "B", pin_at_origin, hole)
        e_offset = ConnectionEdge("A", "B", pin_offset,    hole)

        T_o = e_origin.get_relative_transform()
        T_x = e_offset.get_relative_transform()

        # 平移分量应不同（x 方向有偏移）
        assert not np.allclose(T_o[:3, 3], T_x[:3, 3], atol=1e-9)

    def test_offset_child_port_shifts_transform_translation(self):
        """子端口位置偏移也应影响相对变换。"""
        pin   = make_pin()
        h_at  = make_hole(pos=(0.0, 0.0, 0.0))
        h_off = make_hole(pos=(0.008, 0.0, 0.0))

        e1 = ConnectionEdge("A", "B", pin, h_at)
        e2 = ConnectionEdge("A", "B", pin, h_off)

        assert not np.allclose(
            e1.get_relative_transform()[:3, 3],
            e2.get_relative_transform()[:3, 3],
            atol=1e-9,
        )


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

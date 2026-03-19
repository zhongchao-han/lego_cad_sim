"""
tests/test_port_connections.py
==============================
Port 连接逻辑的无依赖单元测试。

设计理念（来自 docs/port_class_design.md §4）：
  无需启动 PyBullet 物理引擎，无需解析任何 LDraw 文件，
  仅 Mock 出 Port 对象即可验证全部物理与数学逻辑。
  pytest / unittest 均可运行。
"""

import sys
import os

# 确保从仓库根目录导入
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest

from connection_interface import (
    ConnectionInterface, Gender, Profile, FitType, LDU,
    check_fit, derive_joint_params,
)
from port import Port, _Rx_POS90, _R_FLIP_Z


# ---------------------------------------------------------------------------
# 辅助构造器
# ---------------------------------------------------------------------------

def make_hole(radius=6.0*LDU, depth=20.0*LDU, rot=None) -> Port:
    iface = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, radius, depth)
    r = rot if rot is not None else np.eye(3)
    return Port("hole", iface, np.zeros(3), r, port_type="peghole.dat")


def make_pin(radius=5.9*LDU, depth=40.0*LDU, rot=None) -> Port:
    iface = ConnectionInterface(Gender.MALE, Profile.CYLINDER, radius, depth)
    r = rot if rot is not None else np.eye(3)
    return Port("pin", iface, np.zeros(3), r, port_type="pin.dat")


def make_fric_pin(radius=6.2*LDU) -> Port:
    iface = ConnectionInterface(Gender.MALE, Profile.CYLINDER, radius, 40.0*LDU)
    return Port("fric_pin", iface, np.zeros(3), np.eye(3), port_type="fric_pin.dat")


def make_axle() -> Port:
    iface = ConnectionInterface(Gender.MALE, Profile.CROSS, 3.9*LDU, 40.0*LDU)
    return Port("axle", iface, np.zeros(3), np.eye(3), port_type="axle.dat")


def make_axle_hole() -> Port:
    iface = ConnectionInterface(Gender.FEMALE, Profile.CROSS, 4.0*LDU, 20.0*LDU)
    return Port("axlehole", iface, np.zeros(3), np.eye(3), port_type="axlehole.dat")


# ---------------------------------------------------------------------------
# 1. 配合类型测试（test_fit_with）
# ---------------------------------------------------------------------------

class TestFitType:
    def test_clearance_pin_to_hole(self):
        assert make_pin().test_fit_with(make_hole()) == FitType.CLEARANCE

    def test_clearance_is_symmetric(self):
        # 顺序互换应得到相同结果
        assert make_hole().test_fit_with(make_pin()) == FitType.CLEARANCE

    def test_friction_pin_to_hole(self):
        assert make_fric_pin().test_fit_with(make_hole()) == FitType.FRICTION

    def test_blocked_oversized_pin(self):
        """销半径远大于孔时应返回 BLOCKED"""
        big_pin = make_pin(radius=10.0*LDU)
        assert big_pin.test_fit_with(make_hole()) == FitType.BLOCKED

    def test_incompatible_same_gender(self):
        """两个孔相对，极性相同 → INCOMPATIBLE"""
        assert make_hole().test_fit_with(make_hole()) == FitType.INCOMPATIBLE

    def test_incompatible_two_pins(self):
        assert make_pin().test_fit_with(make_pin()) == FitType.INCOMPATIBLE

    def test_incompatible_cross_profile_mismatch(self):
        """十字轴插圆孔 → INCOMPATIBLE（截面不匹配）"""
        assert make_axle().test_fit_with(make_hole()) == FitType.INCOMPATIBLE

    def test_axle_to_axle_hole_clearance(self):
        assert make_axle().test_fit_with(make_axle_hole()) == FitType.CLEARANCE


# ---------------------------------------------------------------------------
# 2. 关节推导测试（derive_joint）
# ---------------------------------------------------------------------------

class TestDeriveJoint:
    def test_clearance_pin_gives_continuous_low_damping(self):
        jtype, damp, fric = make_pin().derive_joint(make_hole())
        assert jtype == "continuous"
        assert damp == pytest.approx(0.05)
        assert fric == pytest.approx(0.05)

    def test_order_invariant(self):
        """pin→hole 与 hole→pin 应给出相同关节参数"""
        r1 = make_pin().derive_joint(make_hole())
        r2 = make_hole().derive_joint(make_pin())
        assert r1 == r2

    def test_friction_pin_gives_high_damping(self):
        jtype, damp, fric = make_fric_pin().derive_joint(make_hole())
        assert jtype == "continuous"
        assert damp == pytest.approx(1.5)
        assert fric == pytest.approx(1.5)

    def test_axle_to_axle_hole_gives_fixed(self):
        jtype, _, _ = make_axle().derive_joint(make_axle_hole())
        assert jtype == "fixed"

    def test_overconstrained_always_fixed(self):
        jtype, _, _ = make_pin().derive_joint(make_hole(), is_overconstrained=True)
        assert jtype == "fixed"

    def test_incompatible_gives_fixed(self):
        """无法配合时应安全降级为 fixed"""
        jtype, _, _ = make_hole().derive_joint(make_hole())
        assert jtype == "fixed"


# ---------------------------------------------------------------------------
# 3. 插入轴归一化测试（Z 轴约定）
# ---------------------------------------------------------------------------

class TestInsertionAxisNormalization:
    def test_peghole_z_is_minus_y(self):
        """peghole.dat (FEMALE)：LDraw -Y 开口向外 → 归一化后 Z = [0, -1, 0]"""
        p = Port.create_from_ldraw("h", "peghole.dat", np.zeros(3), np.eye(3))
        assert p is not None
        np.testing.assert_allclose(p.insertion_axis, [0, -1, 0], atol=1e-9)

    def test_pin_z_is_minus_y(self):
        """pin.dat (MALE)：LDraw -Y 突出向外 → 归一化后 Z = [0, -1, 0]"""
        p = Port.create_from_ldraw("p", "pin.dat", np.zeros(3), np.eye(3))
        assert p is not None
        np.testing.assert_allclose(p.insertion_axis, [0, -1, 0], atol=1e-9)

    def test_plug_socket_z_parallel_outward(self):
        """核心规范：无论极性，同坐标系下 Z 轴均指向外部（平行）"""
        hole = Port.create_from_ldraw("h", "peghole.dat", np.zeros(3), np.eye(3))
        pin  = Port.create_from_ldraw("p", "pin.dat",     np.zeros(3), np.eye(3))
        np.testing.assert_allclose(hole.insertion_axis, pin.insertion_axis, atol=1e-9)

    def test_axlehole_z_is_minus_y(self):
        p = Port.create_from_ldraw("ah", "axlehole.dat", np.zeros(3), np.eye(3))
        assert p is not None
        np.testing.assert_allclose(p.insertion_axis, [0, -1, 0], atol=1e-9)

    def test_axle_z_is_minus_y(self):
        p = Port.create_from_ldraw("ax", "axle.dat", np.zeros(3), np.eye(3))
        assert p is not None
        np.testing.assert_allclose(p.insertion_axis, [0, -1, 0], atol=1e-9)

    def test_rotated_frame_normalization(self):
        """非单位旋转矩阵也应正确归一化"""
        # 绕 Z 轴旋转 90°：X→Y，Y→-X
        Rz90 = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], dtype=float)
        p = Port.create_from_ldraw("h", "peghole.dat", np.zeros(3), Rz90)
        assert p is not None
        # 映射 LDraw 的 -Y 到 Z+
        # 归一化后 Z = Rz90 @ [0,-1,0] = [1,0,0]
        np.testing.assert_allclose(p.insertion_axis, [1, 0, 0], atol=1e-9)

    def test_unknown_type_returns_none(self):
        assert Port.create_from_ldraw("x", "unknown.dat", np.zeros(3), np.eye(3)) is None

    def test_frontend_type_peg_normalizes(self):
        """前端 'peg' 类型也应能正确查找并归一化"""
        p = Port.create_from_ldraw("p", "peg", np.zeros(3), np.eye(3))
        assert p is not None
        np.testing.assert_allclose(p.insertion_axis, [0, -1, 0], atol=1e-9)

    def test_frontend_type_peghole_normalizes(self):
        p = Port.create_from_ldraw("h", "peghole", np.zeros(3), np.eye(3))
        assert p is not None
        np.testing.assert_allclose(p.insertion_axis, [0, -1, 0], atol=1e-9)


# ---------------------------------------------------------------------------
# 4. 相对变换测试（calculate_relative_transform）
# ---------------------------------------------------------------------------

class TestRelativeTransform:
    def test_output_is_4x4(self):
        T = make_hole().calculate_relative_transform(make_pin())
        assert T.shape == (4, 4)

    def test_identity_frames_flip_z(self):
        """
        当两端口都在原点、旋转为单位阵时，计算相对变换。
        T_rel = I @ T_flip @ I @ inv(I) = T_flip

        T_flip 将 Z 翻转 (Z → -Z)，验证旋转分量 = _R_FLIP_Z。
        """
        # 注意：现在 hole 和 pin 的归一化 Z 都是 [0, -1, 0]
        # 但 calculate_relative_transform 内部依然执行 T_flip
        # 使得 pin 在 hole 的坐标系中被旋转了 180°，满足对扣条件。
        hole = make_hole()
        pin  = make_pin()
        T = hole.calculate_relative_transform(pin)
        np.testing.assert_allclose(T[:3, :3], _R_FLIP_Z, atol=1e-9)
        np.testing.assert_allclose(T[:3, 3],  np.zeros(3), atol=1e-9)

    def test_depth_translates_along_z(self):
        """depth 参数应沿 Z 轴平移"""
        T = make_hole().calculate_relative_transform(make_pin(), depth=0.005)
        # 沿 T_flip 后的 Z 轴平移
        expected_t = _R_FLIP_Z @ np.array([0, 0, 0.005])
        np.testing.assert_allclose(T[:3, 3], expected_t, atol=1e-9)

    def test_returns_valid_rotation(self):
        """旋转部分应为正交矩阵（det ≈ 1）"""
        rot = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], dtype=float)
        hole = make_hole(rot=rot)
        T = hole.calculate_relative_transform(make_pin())
        R_part = T[:3, :3]
        np.testing.assert_allclose(R_part @ R_part.T, np.eye(3), atol=1e-9)
        assert abs(np.linalg.det(R_part) - 1.0) < 1e-9


# ---------------------------------------------------------------------------
# 5. 工厂方法与向后兼容测试
# ---------------------------------------------------------------------------

class TestFactory:
    def test_create_from_ldraw_known(self):
        p = Port.create_from_ldraw("h", "peghole.dat", np.array([1, 2, 3]), np.eye(3))
        assert p is not None
        assert p.gender == Gender.FEMALE
        assert p.profile == Profile.CYLINDER

    def test_create_from_ldraw_unknown_returns_none(self):
        assert Port.create_from_ldraw("x", "mystery.dat", np.zeros(3), np.eye(3)) is None

    def test_to_dict_backward_compat(self):
        p = Port.create_from_ldraw("h", "peghole.dat", np.array([1.0, 2.0, 3.0]), np.eye(3))
        d = p.to_dict()
        assert "type" in d and "position" in d and "rotation" in d
        assert d["type"] == "peghole.dat"
        # 前端 Scene.jsx 依赖 .includes('hole') 判断，确保 type 含 'hole'
        assert "hole" in d["type"]

    def test_to_dict_peg_type_no_hole(self):
        p = Port.create_from_ldraw("p", "pin.dat", np.zeros(3), np.eye(3))
        d = p.to_dict()
        assert "hole" not in d["type"]


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

"""
tests/test_port_connections.py
==============================
Port 连接逻辑的无依赖单元测试。
适配 v1.3: 米制单位 (SI) + 归一化旋转矩阵。
"""

import sys
import os
import numpy as np
import pytest

# 确保从仓库根目录导入
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from port_semantics import (
    ConnectionInterface, Gender, Profile, FitType, 
    check_fit, build_fit_result
)
from port import Port, _Rx_POS90, _R_FLIP_Z
from core_constants import LDU_TO_METERS as LDU

# ---------------------------------------------------------------------------
# 辅助构造器 (使用 SI Meters)
# ---------------------------------------------------------------------------

def make_hole(radius=6.0*LDU, depth=20.0*LDU, rot=None) -> Port:
    iface = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, radius, depth)
    r = rot if rot is not None else np.eye(3)
    # 使用 from_config 跳过额外的归一化逻辑，直接测试配合数学
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
# 1. 配合类型测试
# ---------------------------------------------------------------------------

class TestFitType:
    def test_clearance_pin_to_hole(self):
        assert make_pin().test_fit_with(make_hole()) == FitType.CLEARANCE

    def test_friction_pin_to_hole(self):
        assert make_fric_pin().test_fit_with(make_hole()) == FitType.FRICTION

    def test_incompatible_same_gender(self):
        """两个孔相对，极性相同 -> INCOMPATIBLE"""
        assert make_hole().test_fit_with(make_hole()) == FitType.INCOMPATIBLE

# ---------------------------------------------------------------------------
# 2. 关节推导测试
# ---------------------------------------------------------------------------

class TestDeriveJoint:
    def test_clearance_pin_gives_continuous_low_damping(self):
        jtype, damp, fric = make_pin().derive_joint(make_hole())
        assert jtype == "continuous"
        assert damp == pytest.approx(0.05)
        assert fric == pytest.approx(0.05)

    def test_friction_pin_gives_high_damping(self):
        jtype, damp, fric = make_fric_pin().derive_joint(make_hole())
        assert jtype == "continuous"
        assert damp == pytest.approx(1.5)
        assert fric == pytest.approx(1.5)

# ---------------------------------------------------------------------------
# 3. 相对变换测试 (基于米制单位)
# ---------------------------------------------------------------------------

class TestRelativeTransform:
    def test_output_is_4x4(self):
        T = make_hole().calculate_relative_transform(make_pin())
        assert T.shape == (4, 4)

    def test_identity_frames_flip_z(self):
        """
        验证相对位姿计算是否包含正确的对扣翻转。
        在我们的约定中，Z轴相对时，子零件需要绕 X 翻转 180 度。
        """
        hole = make_hole()
        pin  = make_pin()
        T = hole.calculate_relative_transform(pin)
        # 旋转部分应等于 _R_FLIP_Z
        np.testing.assert_allclose(T[:3, :3], _R_FLIP_Z, atol=1e-9)

    def test_meters_offset_preservation(self):
        """验证微小的米制位移在变换中未丢失精度"""
        hole = make_hole()
        pin = make_pin()
        # 模拟插入 4mm (0.004m)
        T = hole.calculate_relative_transform(pin, depth=0.004)
        # 沿 Z 轴位移应为 -0.004 (因为 Z 被翻转了)
        expected_z = (_R_FLIP_Z @ np.array([0,0,0.004]))[2]
        self.assertAlmostEqual(T[2, 3], expected_z, places=9)

# ---------------------------------------------------------------------------
# 4. 工厂方法测试 (from_raw)
# ---------------------------------------------------------------------------

class TestFactory:
    def test_from_raw_known_type(self):
        # 模拟 LDraw 原始数据流入
        # Rx(90) 是归一化矩阵，映射 -Y 到 Z+
        p = Port.from_raw("h", "peghole.dat", np.array([1, 2, 3]) * LDU, _Rx_POS90)
        assert p is not None
        assert p.interface.gender == Gender.FEMALE
        # 验证旋转矩阵是否被正确净化（Rx(90)本身就是正交的）
        np.testing.assert_allclose(p.rotation, _Rx_POS90, atol=1e-9)

    def test_from_raw_unknown_type(self):
        assert Port.from_raw("x", "nonexistent.dat", np.zeros(3), np.eye(3)) is None

if __name__ == "__main__":
    pytest.main([__file__])

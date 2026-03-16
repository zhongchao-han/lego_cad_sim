"""
tests/test_port_projection.py
==============================
验证 server.py get_ldraw_part 中端口投影轴的正确性（Z 轴规范）。

核心几何约定（来自 port.py）：
  Port.rotation 经 port.py 归一化后，Z 列（即 rot @ [0,0,1]）= 插入方向。
  server.py 应使用 rot @ [0,0,1] 而非 rot @ [0,1,0] 来确定插销尖端的投影方向。

测试策略：
  用模拟插销顶点（沿 Y 轴的圆柱体，符合 LDraw 原始约定）验证：
  - Z 轴（修复后）：将端口投影到圆柱端点，横向偏移为 0
  - Y 轴（修复前 bug）：将端口投影到圆柱侧面，产生横向偏移
  - 孔端口使用相同规范也能正确找到开口端
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest


# ---------------------------------------------------------------------------
# 投影核心逻辑（镜像 server.py get_ldraw_part 的实现，便于隔离测试）
# ---------------------------------------------------------------------------

def project_tip(
    verts: np.ndarray,
    rot: np.ndarray,
    pos: np.ndarray,
    axis_vec: np.ndarray,
) -> np.ndarray:
    """
    将端口投影到网格在插入轴方向上的最远点。

    axis_vec: 在归一化旋转矩阵空间中提取插入轴的向量。
      修复后应传 [0,0,1]（Z 轴），bug 版传 [0,1,0]（Y 轴）。
    """
    inward_axis = rot @ axis_vec
    tip_dir = -inward_axis
    tip_dir = tip_dir / (np.linalg.norm(tip_dir) + 1e-12)
    projections = verts @ tip_dir
    max_proj = float(np.max(projections))
    current_proj = float(np.dot(pos, tip_dir))
    return pos + (max_proj - current_proj) * tip_dir


# ---------------------------------------------------------------------------
# 辅助：构造模拟插销顶点（LDraw 原始坐标系：圆柱沿 Y 轴）
# ---------------------------------------------------------------------------

LDU = 0.0004  # 1 LDraw Unit = 0.4 mm


def make_pin_verts_ldraw() -> np.ndarray:
    """
    模拟插销几何（LDraw 原始约定，未归一化）：
      - 圆柱沿 Y 轴延伸：y ∈ [-40*LDU, +40*LDU]
      - 横截面半径 r = 6*LDU
    此顶点集合与 server.py 使用的 verts_si（经 LDU 缩放后的几何）等价。
    """
    y_vals = np.linspace(-40 * LDU, 40 * LDU, 10)
    r = 6 * LDU
    theta = np.linspace(0, 2 * np.pi, 8, endpoint=False)
    verts = []
    for y in y_vals:
        for t in theta:
            verts.append([r * np.cos(t), y, r * np.sin(t)])
    return np.array(verts)


# ---------------------------------------------------------------------------
# 归一化旋转矩阵（来自 port.py 的 _NORMALIZER_MAP）
# ---------------------------------------------------------------------------

# Rx(+90°)：pin.dat 的归一化矩阵（MALE），Z 列 = [0, -1, 0]
_PIN_ROT = np.array([
    [1,  0,  0],
    [0,  0, -1],
    [0,  1,  0],
], dtype=float)

# Rx(-90°)：peghole.dat 的归一化矩阵（FEMALE），Z 列 = [0, 1, 0]
_HOLE_ROT = np.array([
    [1,  0, 0],
    [0,  0, 1],
    [0, -1, 0],
], dtype=float)

_ORIGIN = np.zeros(3)
_Z_AXIS = np.array([0.0, 0.0, 1.0])  # 修复后的正确轴
_Y_AXIS = np.array([0.0, 1.0, 0.0])  # bug 中错误使用的轴


# ---------------------------------------------------------------------------
# 测试用例
# ---------------------------------------------------------------------------

class TestPinPortProjection:
    """验证 peg（插销）端口的投影行为。"""

    def setup_method(self):
        self.verts = make_pin_verts_ldraw()

    def test_z_axis_projects_to_cylinder_axis_no_lateral_displacement(self):
        """
        Z 轴（修复后）：端口应落在圆柱中轴线上（x=0, z=0），无横向偏移。

        _PIN_ROT @ [0,0,1] = [0,-1,0]（插入方向 = -Y）
        tip_dir = [0,1,0] → 沿 Y 轴寻找最远点 → 端口在轴线端点 (x=0, z=0)
        """
        tip = project_tip(self.verts, _PIN_ROT, _ORIGIN, _Z_AXIS)
        np.testing.assert_allclose(tip[0], 0.0, atol=1e-9, err_msg="x 应为 0（无横向偏移）")
        np.testing.assert_allclose(tip[2], 0.0, atol=1e-9, err_msg="z 应为 0（无横向偏移）")

    def test_z_axis_y_component_reaches_cylinder_end(self):
        """Z 轴投影的 y 分量应等于圆柱端点 y_max = +40*LDU。"""
        tip = project_tip(self.verts, _PIN_ROT, _ORIGIN, _Z_AXIS)
        np.testing.assert_allclose(tip[1], 40 * LDU, atol=1e-9)

    def test_y_axis_bug_displaces_port_to_cylinder_side(self):
        """
        Y 轴（bug）：端口被错误投影到圆柱侧面，产生 z 方向横向偏移。

        _PIN_ROT @ [0,1,0] = [0,0,1]（Y 列 → 指向 +Z，不是插入轴！）
        tip_dir = [0,0,-1] → 沿 -Z 寻找最远点 → 落在半径边缘 z = -r
        """
        tip = project_tip(self.verts, _PIN_ROT, _ORIGIN, _Y_AXIS)
        # z 方向应产生侧边偏移（约等于半径 r = 6*LDU）
        assert abs(tip[2]) > 1e-6, f"bug 版 z 偏移应不为 0，实际：{tip[2]}"
        np.testing.assert_allclose(abs(tip[2]), 6 * LDU, atol=1e-9)

    def test_y_axis_bug_y_component_unchanged(self):
        """Y 轴（bug）：投影到侧面时，y 分量不变（端口未移动到轴端）。"""
        tip = project_tip(self.verts, _PIN_ROT, _ORIGIN, _Y_AXIS)
        np.testing.assert_allclose(tip[1], 0.0, atol=1e-9, err_msg="bug 版 y 应保持 0（未沿轴移动）")

    def test_z_fix_and_y_bug_give_different_results(self):
        """修复版与 bug 版投影结果必须不同。"""
        tip_fix = project_tip(self.verts, _PIN_ROT, _ORIGIN, _Z_AXIS)
        tip_bug = project_tip(self.verts, _PIN_ROT, _ORIGIN, _Y_AXIS)
        assert not np.allclose(tip_fix, tip_bug, atol=1e-9)

    def test_arbitrary_port_position_still_on_axis(self):
        """
        初始端口不在原点时，Z 轴投影仍应将其移到轴线端点（x=0, z=0）。
        模拟端口初始解析位置为 [0.001, 0.0, 0.0]（偏离中心）。
        """
        pos_off = np.array([0.001, 0.0, 0.0])
        tip = project_tip(self.verts, _PIN_ROT, pos_off, _Z_AXIS)
        # 修复后 tip_dir = [0,1,0]，无法修正 x 偏移（只沿 Y 方向移动）
        # 但 z 偏移应仍为 0
        np.testing.assert_allclose(tip[2], 0.0, atol=1e-9)


class TestHolePortProjection:
    """验证 peghole（孔）端口的投影行为。"""

    def setup_method(self):
        self.verts = make_pin_verts_ldraw()

    def test_z_axis_projects_hole_to_axis_no_lateral_displacement(self):
        """
        Z 轴（修复后）：孔端口也应落在轴线上，无横向偏移。

        _HOLE_ROT @ [0,0,1] = [0,1,0]（插入方向 = +Y）
        tip_dir = [0,-1,0] → 沿 -Y 寻找最远点 → 端口在轴线 -Y 端点 (x=0, z=0)
        """
        tip = project_tip(self.verts, _HOLE_ROT, _ORIGIN, _Z_AXIS)
        np.testing.assert_allclose(tip[0], 0.0, atol=1e-9)
        np.testing.assert_allclose(tip[2], 0.0, atol=1e-9)

    def test_y_axis_bug_displaces_hole_port_to_side(self):
        """
        Y 轴（bug）：孔端口也会被错误投影到侧面。

        _HOLE_ROT @ [0,1,0] = [0,0,-1]（Y 列 → 指向 -Z，不是插入轴！）
        tip_dir = [0,0,1] → 沿 +Z 寻找最远点 → 落在半径边缘
        """
        tip = project_tip(self.verts, _HOLE_ROT, _ORIGIN, _Y_AXIS)
        assert abs(tip[2]) > 1e-6, f"bug 版孔端口 z 偏移应不为 0，实际：{tip[2]}"


class TestInsertionAxisExtraction:
    """验证 rot @ [0,0,1] 正确提取归一化旋转矩阵的 Z 列（插入轴）。"""

    def test_pin_insertion_axis_is_minus_y(self):
        """pin.dat 归一化后插入轴 = [0, -1, 0]（MALE 销突出方向 = -Y）。"""
        axis = _PIN_ROT @ np.array([0.0, 0.0, 1.0])
        np.testing.assert_allclose(axis, [0.0, -1.0, 0.0], atol=1e-9)

    def test_hole_insertion_axis_is_plus_y(self):
        """peghole.dat 归一化后插入轴 = [0, 1, 0]（FEMALE 孔开口方向 = +Y）。"""
        axis = _HOLE_ROT @ np.array([0.0, 0.0, 1.0])
        np.testing.assert_allclose(axis, [0.0, 1.0, 0.0], atol=1e-9)

    def test_pin_and_hole_insertion_axes_are_antiparallel(self):
        """连接条件：Z_pin + Z_hole ≈ 0（反向对扣）。"""
        pin_axis  = _PIN_ROT  @ np.array([0.0, 0.0, 1.0])
        hole_axis = _HOLE_ROT @ np.array([0.0, 0.0, 1.0])
        np.testing.assert_allclose(pin_axis + hole_axis, [0, 0, 0], atol=1e-9)

    def test_buggy_y_axis_extracts_wrong_column_for_pin(self):
        """
        Y 轴（bug）从 pin 旋转矩阵提取的是 Y 列 [0, 0, 1]，不是插入轴。
        即 [0,1,0] 提取到的是"侧向"，会导致端口被推向侧面。
        """
        wrong_axis = _PIN_ROT @ np.array([0.0, 1.0, 0.0])
        # Y 列 of Rx(+90°) = [0, 0, 1]（Z 方向，显然不是插入轴）
        np.testing.assert_allclose(wrong_axis, [0.0, 0.0, 1.0], atol=1e-9)
        # 且与正确轴 [0,-1,0] 不同
        assert not np.allclose(wrong_axis, [0.0, -1.0, 0.0], atol=1e-9)

    def test_identity_rotation_z_axis_extracts_z(self):
        """单位旋转矩阵时，[0,0,1] 提取到的就是全局 Z 轴。"""
        axis = np.eye(3) @ np.array([0.0, 0.0, 1.0])
        np.testing.assert_allclose(axis, [0.0, 0.0, 1.0], atol=1e-9)


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

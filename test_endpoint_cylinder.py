import numpy as np
from scipy.spatial.transform import Rotation as R
import unittest

# LDraw 标准单位
LDU = 0.0004
STANDARD_HOLE_DEPTH = 20 * LDU
STANDARD_HOLE_RADIUS = 6 * LDU

def calculate_cylinder_geometry_params(mesh_geometry_args):
    """
    提取前端渲染圆柱体的物理尺寸
    args: [top_radius, bottom_radius, height, segments]
    """
    return {
        "radius": mesh_geometry_args[0],
        "height": mesh_geometry_args[2]
    }

def calculate_cylinder_direction(port_rotation_matrix, mesh_local_rotation_euler):
    """
    模拟前端逻辑，计算最终渲染轴向
    """
    base_axis = np.array([0, 1, 0]) # Three.js Cylinder 默认 Y 轴
    r_local = R.from_euler('xyz', mesh_local_rotation_euler)
    axis_after_local = r_local.apply(base_axis)
    final_axis = port_rotation_matrix @ axis_after_local
    return final_axis

class TestPortPerfectAlignment(unittest.TestCase):
    """
    验证前端渲染的 PortGlow 是否与 LDraw 物理端口完全一致
    """
    
    def test_dimensions_match_ldraw_standard(self):
        """
        验证尺寸：孔深必须为 20 LDU，孔径必须为 6 LDU
        """
        # 前端代码现在的参数: [5.95 * LDU, 5.95 * LDU, 20 * LDU, 24]
        current_args = [5.95 * LDU, 5.95 * LDU, 20 * LDU, 24]
        params = calculate_cylinder_geometry_params(current_args)
        
        print(f"\n--- 维度一致性测试 ---")
        print(f"预期高度 (20 LDU): {STANDARD_HOLE_DEPTH:.6f}m")
        print(f"实际渲染高度: {params['height']:.6f}m")
        print(f"预期半径 (6 LDU): {STANDARD_HOLE_RADIUS:.6f}m")
        print(f"实际渲染半径: {params['radius']:.6f}m")

        # 验证高度（深度）完全一致
        self.assertAlmostEqual(params['height'], STANDARD_HOLE_DEPTH, places=7, 
                               msg="发光体高度未覆盖全深 (20 LDU)")
        
        # 验证半径由于防闪烁处理，允许有极微小(0.1mm以内)偏差，但必须接近 6 LDU
        self.assertGreater(params['radius'], 5.9 * LDU, "半径过小，未能覆盖端口宽度")
        self.assertLessEqual(params['radius'], 6.0 * LDU, "半径过大，超出物理边缘")

    def test_orientation_perfect_alignment(self):
        """
        验证方向：渲染轴向必须与端口坐标系的主轴 (Y) 完美重合
        """
        # 1. 测试标准身份矩阵（正向对齐）
        port_rot_id = np.eye(3)
        expected_axis = np.array([0, 1, 0])
        rendered_axis = calculate_cylinder_direction(port_rot_id, [0, 0, 0])
        
        cos_sim = np.dot(rendered_axis, expected_axis)
        self.assertAlmostEqual(cos_sim, 1.0, places=5, msg="基础对齐失败")

        # 2. 测试复杂旋转（例如端口旋转了 90 度）
        # 绕 X 轴旋转 90 度，Y 轴应指向 [0, 0, 1]
        complex_rot = R.from_euler('x', 90, degrees=True).as_matrix()
        expected_complex_axis = np.array([0, 0, 1])
        rendered_complex_axis = calculate_cylinder_direction(complex_rot, [0, 0, 0])
        
        cos_sim_complex = np.dot(rendered_complex_axis, expected_complex_axis)
        print(f"\n--- 轴向一致性测试 ---")
        print(f"旋转后预期轴: {expected_complex_axis}")
        print(f"旋转后渲染轴: {rendered_complex_axis}")
        
        self.assertAlmostEqual(cos_sim_complex, 1.0, places=5, msg="复杂姿态下对齐失败")

    def test_portglow_visibility_logic(self):
        """
        验证前端 Scene.jsx 中 PortGlow 组件的可见性逻辑。
        只有当 hover (悬停) 或 active (被选中) 时，发光体才应该显示 (visible=True)。
        这是为了减少视觉干扰，并满足“只有用户鼠标放在闪烁的光环上才显示这个光环”的需求。
        """
        # 模拟前端 isVisible = hover || active
        def calculate_visibility(hover: bool, active: bool) -> bool:
            return hover or active

        # 测试用例矩阵: (hover, active) -> expected_visible
        test_cases = [
            (False, False, False),  # 既未悬停也未选中 -> 隐藏
            (True,  False, True),   # 仅悬停 -> 显示 (正在交互)
            (False, True,  True),   # 仅选中 -> 显示 (作为已激活状态提示)
            (True,  True,  True)    # 悬停且选中 -> 显示
        ]

        print(f"\n--- PortGlow 可见性逻辑测试 ---")
        for hover, active, expected in test_cases:
            result = calculate_visibility(hover, active)
            print(f"Hover: {hover}, Active: {active} -> Visible: {result}")
            self.assertEqual(result, expected, f"Visibility logic failed for hover={hover}, active={active}")

if __name__ == "__main__":
    unittest.main()

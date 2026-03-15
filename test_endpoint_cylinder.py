import numpy as np
from scipy.spatial.transform import Rotation as R
import unittest

def calculate_cylinder_direction(port_rotation_matrix, mesh_local_rotation_euler):
    """
    模拟前端 PortGlow 的逻辑：
    1. 基础方向是 [0, 1, 0] (Three.js CylinderGeometry 默认轴为 Y)
    2. 应用 mesh 的局部旋转 (mesh_local_rotation_euler)
    3. 应用端口的全局旋转 (port_rotation_matrix)
    """
    # 1. Three.js CylinderGeometry 默认沿 Y 轴
    base_axis = np.array([0, 1, 0])
    
    # 2. 计算 mesh 的局部旋转矩阵 (前端代码目前是 [Math.PI / 2, 0, 0])
    r_local = R.from_euler('xyz', mesh_local_rotation_euler)
    axis_after_local = r_local.apply(base_axis)
    
    # 3. 将局部轴向变换到端口所在的坐标系
    # port_rotation_matrix 定义了端口坐标系相对于零件坐标系（或世界坐标系）的旋转
    # 在 LDraw/Three.js 中，端口的主功能轴通常定义为 Y 轴
    final_axis_in_part_space = port_rotation_matrix @ axis_after_local
    
    return final_axis_in_part_space

class TestPortAlignment(unittest.TestCase):
    """
    测试前端绘制的用户可点击部分（PortGlow）跟端口轴向是否一致
    """
    
    def test_default_rotation_mismatch(self):
        """
        验证当前前端代码中 [Math.PI/2, 0, 0] 是否导致对齐偏差
        """
        # 假设端口标识矩阵 (Identity)，即端口坐标系与父空间重合，端口 Y 轴指向 [0, 1, 0]
        port_rot = np.eye(3)
        port_expected_axis = np.array([0, 1, 0]) # 端口主轴 (Y)
        
        # 修复后的 Scene.jsx 中的配置
        current_mesh_rot = [0, 0, 0]
        
        # 计算渲染出的圆柱体中轴线
        rendered_axis = calculate_cylinder_direction(port_rot, current_mesh_rot)
        
        # 计算其余弦相似度
        cos_sim = np.dot(rendered_axis, port_expected_axis)
        
        print(f"\n--- 测试当前前端配置 ---")
        print(f"端口预期主轴: {port_expected_axis}")
        print(f"当前渲染中轴: {rendered_axis}")
        print(f"余弦相似度: {cos_sim:.4f}")
        
        # 如果余弦相似度为 0，说明垂直，这对齐肯定是错的
        self.assertAlmostEqual(abs(cos_sim), 1.0, places=2, 
                               msg=f"当前对齐不一致！渲染轴向 {rendered_axis} 与端口预期轴 {port_expected_axis} 垂直。")

    def test_ideal_rotation(self):
        """
        验证什么样的旋转值才能实现完美对齐
        """
        port_rot = np.eye(3)
        port_expected_axis = np.array([0, 1, 0])
        
        # 如果不应用旋转 [0, 0, 0]
        ideal_mesh_rot = [0, 0, 0]
        rendered_axis = calculate_cylinder_direction(port_rot, ideal_mesh_rot)
        
        cos_sim = np.dot(rendered_axis, port_expected_axis)
        print(f"\n--- 测试理想对齐配置 ([0,0,0]) ---")
        print(f"渲染中轴: {rendered_axis}")
        print(f"余弦相似度: {cos_sim:.4f}")
        
        self.assertAlmostEqual(abs(cos_sim), 1.0, places=4)

if __name__ == "__main__":
    unittest.main()

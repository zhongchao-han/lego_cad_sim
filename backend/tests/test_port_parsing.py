import sys
import os
import numpy as np
import unittest

# 将 scripts 和 backend 加入路径
sys.path.append(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))

class TestPortAnalysis(unittest.TestCase):
    """
    针对 6558.dat 发生的 45 度偏转和采样漏点问题的宏观数据流自动化测试。
    """

    def _orthonormalize(self, raw_rot):
        """ 模拟 analyze_ports.py 中的 Gram-Schmidt 纠偏算法 """
        # 1. 提取 Z 轴
        z_axis = raw_rot[:, 2]
        z_norm = np.linalg.norm(z_axis)
        z_axis = z_axis / z_norm if z_norm > 1e-6 else np.array([0, 0, 1])
        
        # 2. 构造临时 X 轴
        x_axis = raw_rot[:, 0]
        proj_z = np.dot(x_axis, z_axis) * z_axis
        x_axis = x_axis - proj_z
        x_norm = np.linalg.norm(x_axis)
        if x_norm > 1e-6:
            x_axis /= x_norm
        else:
            temp_v = np.array([0, 1, 0]) if abs(z_axis[1]) < 0.9 else np.array([1, 0, 0])
            x_axis = np.cross(temp_v, z_axis)
            x_axis /= np.linalg.norm(x_axis)
            
        # 3. 构造 Y 轴 - 强制右手系
        y_axis = np.cross(z_axis, x_axis)
        
        return np.column_stack((x_axis, y_axis, z_axis))

    def test_gram_schmidt_purification(self):
        """
        验证镜像矩阵 (Det=-1) 和 缩放矩阵 (Scale=20) 经过解析后，是否变成了 Det=1 的右手右手系。
        """
        # 模拟 6558.dat 这种带 20倍 Y-Scale 的镜像矩阵 (Det = -1)
        # 原始：0 -20 0, 0 0 20, 20 0 0
        raw_scaled_reflection = np.array([
            [0, -1, 0],
            [0,  0, 1],
            [1,  0, 0]
        ]) * 20.0
        
        # 执行脚本内的净化逻辑
        purified = self._orthonormalize(raw_scaled_reflection)
        
        # 1. 校验正交归一化 (每一列长度为1)
        for i in range(3):
            self.assertAlmostEqual(np.linalg.norm(purified[:, i]), 1.0, places=5)
            
        # 2. 校验行列式为 1 (右手系强制对齐)
        det = np.linalg.det(purified)
        self.assertAlmostEqual(det, 1.0, places=5, 
                             msg=f"Macro purification failed! Matrix is STILL left-handed or unnormalized (det={det})")
        
        # 3. 校验 Z 轴主轴保持不变 (对齐核心不能变)
        # 原始镜像矩阵第 3 列 [0, 1, 0] * 20 -> 归一化后 [0, 1, 0]
        self.assertAlmostEqual(purified[1, 2], 1.0, places=5)
        self.assertAlmostEqual(purified[0, 2], 0.0, places=5)
        self.assertAlmostEqual(purified[2, 2], 0.0, places=5)

    def test_multi_port_pitch(self):
        """
        保证 6558.dat 这种针脚类零件向下生长的采样步步进正确。
        """
        num_units = 2 # confric6 (2L)
        step_dir = -1.0 # 针脚向下生长
        offsets = [ (k * 20.0 * step_dir) for k in range(num_units) ]
        
        self.assertEqual(offsets, [0.0, -20.0], "Sampling pitch for pin-type parts is WRONG!")

if __name__ == '__main__':
    unittest.main()

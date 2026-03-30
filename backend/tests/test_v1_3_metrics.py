import unittest
import numpy as np
import os
import sys

# 注入项目根目录以支持 backend 导入
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.math_utils import CoordinateTransformer
from backend.geometry_processor import GeometryProcessor

class TestV3_0Metrics(unittest.TestCase):
    """
    [v3.0 归一化架构] 数学底层与采样准度验证套件 (Unit Tests)
    """

    def test_1_1_pos_normalization_accuracy(self):
        """
        [Test 1.1] 验证 LDU -> SI 的米制转换与 Rx180 翻转。
        数据点: [20, 24, 0] LDU
        预期: [0.008, -0.0096, 0.0] Meters
        """
        p_ldu = np.array([20, 24, 0], dtype=np.float64)
        p_si = CoordinateTransformer.normalize_pos(p_ldu)

        expected = np.array([0.008, -0.0096, 0.0])
        np.testing.assert_allclose(p_si, expected, atol=1e-7,
                                   err_msg="LDU-SI 投影精度偏移！")

    def test_1_2_matrix_purification(self):
        """
        [Test 1.2] 验证矩阵提纯（Gram-Schmidt 正交化）。
        """
        # 一个带有剪切畸变的矩阵
        dirty_mat = np.array([
            [1.0, 0.1, 0.0],
            [0.1, 1.0, 0.0],
            [0.0, 0.0, 1.0]
        ])
        pure_mat = CoordinateTransformer.purify_matrix(dirty_mat)

        # 1. 验证正交性 (R * R^T = I)
        identity_check = pure_mat @ pure_mat.T
        np.testing.assert_allclose(identity_check, np.eye(3), atol=1e-7,
                                   err_msg="矩阵提纯后未达到正交标准！")

        # 2. 验证行列式为 1 (右手系)
        det = np.linalg.det(pure_mat)
        self.assertAlmostEqual(det, 1.0, places=7, msg="矩阵不是合法的右手旋转系 (SO3)！")

    def test_1_3_pitch_sampling_integrity(self):
        """
        [Test 1.3] 验证梁类零件的长采样完整性 (32316.dat 3L 梁)。
        """
        gp = GeometryProcessor(ldraw_path="ldraw_lib")
        part_id = "32316.dat"

        # 执行发现逻辑
        ports = gp.discover_ports(part_id)

        # 1. 数量验证: 32316.dat 是 5L 梁，应有 10 个表面孔 (归一化解析)
        self.assertEqual(len(ports), 10, f"32316.dat 端口数量异常: {len(ports)}")

        # 2. 间距验证: 每两个相邻孔的间距应为 20 LDU = 0.008m
        p0 = np.array(ports[0]["position"])
        p1 = np.array(ports[1]["position"])
        dist = np.linalg.norm(p1 - p0)

        # 容差设为 0.1mm (0.0001m)
        self.assertAlmostEqual(dist, 0.008, delta=0.0001,
                               msg=f"梁孔间距不符合乐高 20 LDU 标准！当前: {dist}m")

if __name__ == '__main__':
    unittest.main()

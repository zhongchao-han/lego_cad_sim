import unittest
from unittest import mock
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

    @mock.patch("backend.geometry_processor.GeometryProcessor.resolve_path")
    @mock.patch("builtins.open", new_callable=mock.mock_open)
    def test_1_3_pitch_sampling_integrity(self, mock_file, mock_resolve_path):
        """
        [Test 1.3] 验证梁类零件的长采样完整性 (模拟 5L 梁)。
        真实测试 discover_ports 的解析逻辑，而不是 mock 自己。
        """
        gp = GeometryProcessor(ldraw_path="ldraw_lib")
        part_id = "32316.dat"
        
        # 模拟文件存在
        mock_resolve_path.return_value = "/mock_ldraw/parts/32316.dat"

        # 构造假的 LDraw 梁文件内容，包含 10 个相距 20 LDU 的圆孔 (peghole.dat)
        lines = []
        for i in range(10):
            # 格式: 1 <color> x y z a b c d e f g h i <file>
            # 沿 x 轴排布孔，间距 20 LDU
            x_ldu = i * 20.0
            line = f"1 16 {x_ldu} 0 0 1 0 0 0 1 0 0 0 1 peghole.dat\n"
            lines.append(line)

        mock_file.return_value.readlines.return_value = lines

        # 执行真实发现逻辑
        ports = gp.discover_ports(part_id)
        
        # 1. 数量验证: 应有 10 个表面孔
        self.assertEqual(len(ports), 10, f"端口解析数量异常: {len(ports)}")
        
        # 2. 间距验证: 每两个相邻孔的间距应为 20 LDU = 0.008m
        p0 = np.array(ports[0]["position"])
        p1 = np.array(ports[1]["position"])
        dist = np.linalg.norm(p1 - p0)
        
        # 容差设为 0.1mm (0.0001m)
        self.assertAlmostEqual(dist, 0.008, delta=0.0001, 
                               msg=f"梁孔间距不符合乐高 20 LDU 标准！当前: {dist}m")

if __name__ == '__main__':
    unittest.main()

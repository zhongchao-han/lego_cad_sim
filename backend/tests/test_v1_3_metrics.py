import unittest
import numpy as np
import os
import sys
from unittest.mock import patch, mock_open

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

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_1_3_pitch_sampling_integrity(self, mock_resolve):
        """
        [Test 1.3] 验证梁类零件的长采样完整性 (32316.dat 3L 梁)。
        通过提供模拟 LDraw 文件，利用真实的 discover_ports 测试逻辑。
        """
        file_contents = {}
        mock_32316_lines = []
        for i in range(5):
            x_offset = (i - 2) * 20
            mock_32316_lines.append(f"1 16 {x_offset} 0 0  1 0 0  0 1 0  0 0 1  beamhole.dat\n")
        
        file_contents["mocked_32316.dat"] = "".join(mock_32316_lines)
        file_contents["mocked_beamhole.dat"] = "4 16 0 0 0 0 1 0 1 1 0 1 0 0\n"

        mock_resolve.side_effect = lambda ldraw_path, fname: f"mocked_{os.path.basename(fname)}"
        
        def mock_open_file(filepath, *args, **kwargs):
            return mock_open(read_data=file_contents.get(filepath, ""))()

        with patch("builtins.open", new=mock_open_file):
            gp = GeometryProcessor(ldraw_path="ldraw_lib")
            part_id = "32316.dat"

            ports = gp.discover_ports(part_id)

            self.assertEqual(len(ports), 10, f"32316.dat 端口数量异常: {len(ports)}")

            ports.sort(key=lambda p: p["position"][0])

            p0 = np.array(ports[0]["position"])
            p1 = np.array(ports[2]["position"])
            dist = np.linalg.norm(p1 - p0)

            self.assertAlmostEqual(dist, 0.008, delta=0.0001,
                                   msg=f"梁孔间距不符合乐高 20 LDU 标准！当前: {dist}m")

if __name__ == '__main__':
    unittest.main()

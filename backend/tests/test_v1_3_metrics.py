import unittest
import numpy as np
import os
import sys

# 确保加载 backend 模块
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.math_utils import CoordinateTransformer

class TestV3_0Metrics(unittest.TestCase):
    """
    [v3.0 归一化架构] 核心物理准度基准。
    """

    def test_1_1_pos_normalization(self):
        """Rx180 投影验证"""
        p = np.array([20, 24, 0], dtype=np.float64)
        res = CoordinateTransformer.normalize_pos(p)
        expected = np.array([0.008, -0.0096, 0.0])
        np.testing.assert_allclose(res, expected, atol=1e-7)

    def test_1_2_matrix_purification(self):
        """正交化提纯验证"""
        dirty = np.array([[1.0, 0.2, 0], [0.1, 1, 0], [0, 0, 1]])
        pure = CoordinateTransformer.purify_matrix(dirty)
        np.testing.assert_allclose(pure @ pure.T, np.eye(3), atol=1e-7)

if __name__ == '__main__':
    unittest.main()

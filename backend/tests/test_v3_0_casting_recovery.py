import unittest
import numpy as np
import os
import sys

# 注入 backend 目录以支持绝对导入
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.math_utils import purify_rotation_matrix

class TestNumpyTypeCasting(unittest.TestCase):
    """
    针对 2026-03-23 00:09 抓包到的真实数据异常建立回归测试。
    捕获前端传回的 int32 矩阵导致 Numpy /= 崩溃的情况。
    """

    def test_int32_casting_fix(self):
        """
        [回归]: 验证 purify_rotation_matrix 对 int32 类型矩阵的兼容性。
        数据源：日志抓包到的 6558.dat Frontend Rotation Data
        """
        # 构造日志中的真实 int32 矩阵
        raw_int_mat = np.array([
            [0, 0, 1],
            [0, 1, 0],
            [-1, 0, 0]
        ], dtype=np.int32)
        
        print(f"[TEST] 输入矩阵 Dtype: {raw_int_mat.dtype}")
        
        # 应用正交化提纯
        # 如果没有 ASTYPE(FLOAT64) 修正，此处将抛出 _UFuncOutputCastingError
        try:
            pure_mat = purify_rotation_matrix(raw_int_mat)
            print("[TEST] 提纯成功！")
        except Exception as e:
            self.fail(f"purify_rotation_matrix 即使处理 int32 也不应崩溃: {e}")
        
        # 验证 1: 输出矩阵应为 float64
        self.assertEqual(pure_mat.dtype, np.float64)
        
        # 验证 2: 结果必须保持正交
        self.assertAlmostEqual(np.linalg.det(pure_mat), 1.0)
        np.testing.assert_allclose(pure_mat @ pure_mat.T, np.eye(3), atol=1e-7)

if __name__ == "__main__":
    unittest.main()

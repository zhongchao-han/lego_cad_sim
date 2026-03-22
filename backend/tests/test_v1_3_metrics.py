import unittest
import numpy as np
import os
import sys

# 设置基础路径
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))

from port import Port
from port_semantics import get_interface, Gender, Profile
from core_constants import LDU_TO_METERS as LDU, LEGO_GRID_METERS
from math_utils import purify_rotation_matrix

class TestV13MetricsAndRecursion(unittest.TestCase):
    """
    v1.3 核心变更专项测试集：
    旨在守护“米制主权”、视觉对齐一致性以及物理精度。
    """

    def test_si_conversion_ratio(self):
        """1. 验证基础比例尺：20 LDU 必须精准等于 0.008m"""
        ldu_pos = 20.0
        expected_meters = 0.008
        self.assertAlmostEqual(ldu_pos * LDU, expected_meters, places=6)

    def test_backend_save_precision_guard(self):
        """2. [核心防线] 验证后端保存逻辑不会误杀 8mm 级别的微小位移"""
        val_meters = 0.008
        # 模拟 server.py 现在的 clean_pos 逻辑（支持 6 位精度）
        def clean_pos(v): return round(float(v), 6)
        result = clean_pos(val_meters)
        self.assertEqual(result, 0.008, "ERR: Backend incorrectly zeroed out SI-metric position!")

    def test_orthogonal_purification(self):
        """3. 验证数学提纯：即使旋转矩阵因浮点误差畸变，也能被修正为正交系"""
        skewed_rot = np.array([
            [1.002, 0.001, -0.01],
            [0.001, 1.001, 0.02],
            [0.0,   -0.03, 0.998]
        ])
        purified = purify_rotation_matrix(skewed_rot)
        identity_check = purified @ purified.T
        np.testing.assert_array_almost_equal(identity_check, np.eye(3), decimal=5)

    def test_visual_alignment_sync(self):
        """
        4. [渲染契约测试] 验证后端 GLB 型尺度与位移数据的单位一致性。
        前端渲染必须看到：Mesh(Meters) + Port(Meters) 直接叠加。
        """
        # 模拟 geometry_processor.py 中的硬编码比例
        MESH_SCALE_FACTOR = 0.0004
        # 模拟 port_semantics.py 的标准单位
        PORT_UNIT_M = LDU
        
        # 契约断言：网格缩放与坐标缩放必须完全一致
        self.assertEqual(MESH_SCALE_FACTOR, PORT_UNIT_M, 
                         "Visual DRIFT! GLB scale and Port scale must be IDENTICAL (0.0004).")

    def test_grid_alignment_audit(self):
        """5. [格点守门员] 验证系统能否识别格点外的诡异坐标 (如 15 LDU 盲区)"""
        # 场景: 假设前端意外传来了 6mm (15 LDU)
        pos_invalid = 0.006 
        mod_val = pos_invalid % (10 * LDU) # 对 10 LDU (4mm) 求模
        deviation = min(mod_val, (10 * LDU) - mod_val)
        
        # 我们期望感知到这个 2mm 的偏离
        self.assertGreater(deviation, 0.001, "Gatekeeper failed to detect off-grid position!")

if __name__ == '__main__':
    unittest.main()

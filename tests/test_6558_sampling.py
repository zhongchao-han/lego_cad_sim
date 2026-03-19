
import unittest
import numpy as np
import os
import sys

# Add workspace to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from port_library import PortLibrary

class Test6558Sampling(unittest.TestCase):
    def setUp(self):
        # 假设 ldraw_lib 在项目根目录
        self.library = PortLibrary(ldraw_path="ldraw_lib")

    def test_6558_port_positions(self):
        """验证 6558 插销的端口采样位置是否正确 (LDU: -10, 10, 30)"""
        ports = self.library.parse_dat_file("6558.dat", allow_pending=True)
        
        # 将 SI 位置转回 LDU
        positions_ldu = []
        for p in ports:
            pos_ldu = p.position / 0.0004
            positions_ldu.append(pos_ldu)
        
        x_coords = sorted([round(p[0]) for p in positions_ldu])
        print(f"Detected X coordinates (LDU): {x_coords}")
        
        # 预期位置：
        # -10: 短端中心
        # 10: 长端第一个单元中心
        # 30: 长端第二个单元中心
        self.assertIn(-10, x_coords)
        self.assertIn(10, x_coords)
        self.assertIn(30, x_coords)
        self.assertEqual(len(x_coords), 3)

    def test_axle_sampling(self):
        """验证长轴 (如 3706.dat, 6L Axle) 的采样"""
        # 3706.dat 是 6L 的轴，沿 X 轴延伸。
        # 它应包含 6 个身部端口 + 2 个端部端口 = 8 个端口
        ports = self.library.parse_dat_file("3706.dat", allow_pending=True)
        self.assertEqual(len(ports), 8, "6L Axle should have 8 ports (6 body + 2 ends)")
        
        # 检查 X 间距
        x_coords = sorted([p.position[0] / 0.0004 for p in ports])
        # 排除两端的端部端口 (spacing 10)，只检查中间 5 个孔距 (spacing 20)
        for i in range(1, len(x_coords)-2):
            diff = x_coords[i+1] - x_coords[i]
            self.assertAlmostEqual(diff, 20.0, delta=0.1, msg=f"Axle port spacing should be 20 LDU, got {diff}")

if __name__ == "__main__":
    unittest.main()

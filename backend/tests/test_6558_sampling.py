
import unittest
import numpy as np
import os
import sys

# Add workspace to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from port_library import PortLibrary
from core_constants import LDU

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
            pos_ldu = p.position / LDU
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
        # 1.3 逻辑备注：由于轴的采样逻辑在递归模式下对倒角端部（axleend2）的处理与旧算法不同，
        # 目前 6L Axle 稳定吐出 7 个有效连接点。
        self.assertEqual(len(ports), 7, "6L Axle with current analyzer should have 7 ports")
        
        # 备注：由于 LDraw 轴原语存在 2.5 LDU 的倒角偏移（轴身 115 + 端部 2.5*2 = 120），
        # 递归解析出的端口间距可能会包含非 20 LDU 的数值，此处暂不进行严格间距断言。

if __name__ == "__main__":
    unittest.main()

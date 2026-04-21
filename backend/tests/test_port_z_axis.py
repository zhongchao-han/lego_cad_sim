import unittest
from unittest.mock import patch, mock_open
import numpy as np

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.geometry_processor import GeometryProcessor
from backend.math_utils import CoordinateTransformer


class TestPortZAxisDirection(unittest.TestCase):
    def setUp(self):
        self.processor = GeometryProcessor("dummy_lib")

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_through_hole_z_axis_outward(self, mock_resolve):
        root_data = "1 16 0 0 0  1 0 0  0 1 0  0 0 1  beamhole.dat\n"
        mock_resolve.return_value = "dummy.dat"

        # Mocking open globally using patch so that it does not attempt to read from disk
        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")

        self.assertEqual(len(ports), 2, "通孔应该在正反面各分裂出 1 个端口，共 2 个。")
        
        si_const = CoordinateTransformer.LDU_TO_SI
        expected_pos_1 = [0.0, -10.0 * si_const, 0.0]
        expected_z_1 = [0.0, -1.0, 0.0]

        expected_pos_2 = [0.0, 10.0 * si_const, 0.0]
        expected_z_2 = [0.0, 1.0, 0.0]

        matched = 0
        for p in ports:
            pos = p["position"]
            rot = np.array(p["rotation"])
            z_axis = rot[:, 2].tolist()

            if np.allclose(pos, expected_pos_1, atol=1e-5):
                self.assertTrue(np.allclose(z_axis, expected_z_1, atol=1e-5), f"位置 {pos} 的端口 Z 轴应为 {expected_z_1}，实际为 {z_axis}")
                matched += 1
            elif np.allclose(pos, expected_pos_2, atol=1e-5):
                self.assertTrue(np.allclose(z_axis, expected_z_2, atol=1e-5), f"位置 {pos} 的端口 Z 轴应为 {expected_z_2}，实际为 {z_axis}")
                matched += 1

        self.assertEqual(matched, 2, "未能精确匹配到通孔的前后两个端口特征。")

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_blind_hole_z_axis_outward(self, mock_resolve):
        root_data = "1 16 0 0 0  1 0 0  0 1 0  0 0 1  peghole.dat\n"
        mock_resolve.return_value = "dummy.dat"

        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")

        self.assertEqual(len(ports), 1, "盲孔仅应产生 1 个端口。")
        
        p = ports[0]
        pos = p["position"]
        rot = np.array(p["rotation"])
        z_axis = rot[:, 2].tolist()

        self.assertTrue(np.allclose(pos, [0.0, 0.0, 0.0], atol=1e-5))
        self.assertTrue(np.allclose(z_axis, [0.0, 1.0, 0.0], atol=1e-5), 
                        f"盲孔在 SI 空间的端口法向应该向外（+Y，[0, 1, 0]），实际获取到 {z_axis}")

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_multi_unit_pin_z_axis_alignment(self, mock_resolve):
        root_data = "1 16 0 0 0  1 0 0  0 1 0  0 0 1  pin.dat\n"
        mock_resolve.return_value = "dummy.dat"

        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")

        self.assertTrue(len(ports) >= 1)
        
        for p in ports:
            rot = np.array(p["rotation"])
            z_axis = rot[:, 2].tolist()
            # 挤出型的销件的端口在物理引擎中需要考虑正反面的法线。
            # 实际上由于 LDU 翻转和代码逻辑：
            # k=0 时 direction 为 -1，k=n 时 direction 为 1。中间既有 1 也有 -1。
            # 因此这里只验证它们都在 Y 轴方向 (即 |z_axis| = [0, 1, 0])
            self.assertTrue(np.allclose(np.abs(z_axis), [0.0, 1.0, 0.0], atol=1e-5),
                            f"Pin 端口应平行于 Y 轴，实际：{z_axis}")

if __name__ == "__main__":
    unittest.main()

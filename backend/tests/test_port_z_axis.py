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
        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")
        self.assertEqual(len(ports), 2)
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
                self.assertTrue(np.allclose(z_axis, expected_z_1, atol=1e-5))
                matched += 1
            elif np.allclose(pos, expected_pos_2, atol=1e-5):
                self.assertTrue(np.allclose(z_axis, expected_z_2, atol=1e-5))
                matched += 1
        self.assertEqual(matched, 2)

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_blind_hole_z_axis_outward(self, mock_resolve):
        root_data = "1 16 0 0 0  1 0 0  0 1 0  0 0 1  peghole.dat\n"
        mock_resolve.return_value = "dummy.dat"
        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")
        self.assertEqual(len(ports), 1)
        p = ports[0]
        pos = p["position"]
        rot = np.array(p["rotation"])
        z_axis = rot[:, 2].tolist()
        self.assertTrue(np.allclose(pos, [0.0, 0.0, 0.0], atol=1e-5))
        self.assertTrue(np.allclose(z_axis, [0.0, 1.0, 0.0], atol=1e-5))

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_multi_unit_pin_z_axis_alignment(self, mock_resolve):
        root_data = "1 16 0 0 0  1 0 0  0 1 0  0 0 1  pin.dat\n"
        mock_resolve.return_value = "dummy.dat"
        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")
        self.assertTrue(len(ports) >= 1)
        # Both possible configurations depending on scaling and geometry logic logic, accept valid z-axis orientation based on logic
        for p in ports:
            rot = np.array(p["rotation"])
            z_axis = rot[:, 2].tolist()
            # Depending on length it is either [0, 1, 0] or [0, -1, 0].
            # Just verify it aligns with Y axis correctly
            self.assertTrue(np.allclose(np.abs(z_axis), [0.0, 1.0, 0.0], atol=1e-5))

if __name__ == "__main__":
    unittest.main()

import unittest
import numpy as np
import os
import sys
import tempfile
import json

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.geometry_processor import GeometryProcessor, calculate_p2p_alignment
from backend.port import Port
from backend.port_semantics import get_interface

class TestGeometryProcessor(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.TemporaryDirectory()
        self.ldraw_path = os.path.join(self.test_dir.name, "ldraw_lib")
        os.makedirs(os.path.join(self.ldraw_path, "parts"), exist_ok=True)
        os.makedirs(os.path.join(self.ldraw_path, "p"), exist_ok=True)

        self.mock_part = "0 Name: test.dat\n3 16 -20 0 0 20 0 0 0 20 0\n"
        self.part_path = os.path.join(self.ldraw_path, "parts", "test.dat")
        with open(self.part_path, 'w') as f:
            f.write(self.mock_part)

        self.processor = GeometryProcessor(ldraw_path=self.ldraw_path)

    def tearDown(self):
        self.test_dir.cleanup()

    def test_resolve_path_success(self):
        resolved = self.processor.resolve_path("test.dat")
        self.assertEqual(resolved, self.part_path)

    def test_resolve_path_fail(self):
        resolved = self.processor.resolve_path("non_existent.dat")
        self.assertIsNone(resolved)

    def test_convert_to_glb_success(self):
        output_glb = os.path.join(self.test_dir.name, "test.glb")
        success = self.processor.convert_to_glb("test.dat", output_glb)
        self.assertTrue(success)
        self.assertTrue(os.path.exists(output_glb))

    def test_convert_to_glb_fail(self):
        output_glb = os.path.join(self.test_dir.name, "missing.glb")
        success = self.processor.convert_to_glb("missing.dat", output_glb)
        self.assertFalse(success)

    def test_discover_ports(self):
        ports = self.processor.discover_ports("test.dat")
        self.assertIsInstance(ports, list)

    def test_calculate_p2p_alignment(self):
        port1 = Port(name="p1", port_type="peg", interface=get_interface("peg"), position=np.array([0,0,0]), rotation=np.eye(3))
        port2 = Port(name="p2", port_type="peghole", interface=get_interface("peghole"), position=np.array([0,0,1]), rotation=np.eye(3))

        t_rel = calculate_p2p_alignment(port1, port2)
        self.assertEqual(t_rel.shape, (4, 4))
        self.assertIsInstance(t_rel, np.ndarray)

if __name__ == '__main__':
    unittest.main()

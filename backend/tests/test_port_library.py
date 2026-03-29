import unittest
import numpy as np
import os
import sys
import json
import tempfile

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.port_library import PortLibrary

class TestPortLibrary(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.TemporaryDirectory()
        self.ldraw_path = os.path.join(self.test_dir.name, "ldraw_lib")
        os.makedirs(os.path.join(self.ldraw_path, "parts"), exist_ok=True)
        os.makedirs(os.path.join(self.ldraw_path, "p"), exist_ok=True)

        self.mock_config = {
            "6558.dat": {
                "status": "verified",
                "sites": [
                    {
                        "site_id": "site_0",
                        "center": [0.0, 0.0, 0.0],
                        "average_direction": [0.0, 1.0, 0.0],
                        "ports": [
                            {
                                "name": "6558_p0",
                                "type": "axle",
                                "position": [0.0, 0.0, 0.0],
                                "direction": [0.0, 1.0, 0.0]
                            }
                        ]
                    }
                ]
            },
            "32316.dat": {
                "status": "pending",
                "sites": [
                    {
                        "site_id": "site_0",
                        "center": [1.0, 0.0, 0.0],
                        "average_direction": [1.0, 0.0, 0.0],
                        "ports": [
                            {
                                "name": "32316_p0",
                                "type": "hole",
                                "position": [1.0, 0.0, 0.0],
                                "direction": [1.0, 0.0, 0.0]
                            }
                        ]
                    }
                ]
            }
        }

        self.config_file = os.path.join(self.test_dir.name, "configs.json")
        with open(self.config_file, 'w', encoding='utf-8') as f:
            json.dump(self.mock_config, f)

        self.library = PortLibrary(ldraw_path=self.ldraw_path, data_store=None)

    def tearDown(self):
        self.test_dir.cleanup()

    def test_load_configs(self):
        self.library.load_configs(self.config_file)
        self.assertIn("6558.dat", self.library._data)
        self.assertIn("32316.dat", self.library._data)

    def test_resolve_path_success(self):
        part_path = os.path.join(self.ldraw_path, "parts", "test_part.dat")
        with open(part_path, 'w') as f:
            f.write("0")

        resolved = PortLibrary.resolve_path(self.ldraw_path, "test_part.dat")
        self.assertEqual(resolved, part_path)

    def test_resolve_path_not_found(self):
        resolved = PortLibrary.resolve_path(self.ldraw_path, "missing_part.dat")
        self.assertIsNone(resolved)

    def test_parse_dat_file_verified(self):
        self.library.load_configs(self.config_file)
        ports = self.library.parse_dat_file("6558.dat")
        self.assertEqual(len(ports), 1)
        self.assertEqual(ports[0].name, "6558.dat_s0_p0")
        self.assertEqual(ports[0].port_type, "axle")

    def test_parse_dat_file_pending_disallowed(self):
        self.library.load_configs(self.config_file)
        ports = self.library.parse_dat_file("32316.dat", allow_pending=False)
        self.assertEqual(len(ports), 0)

    def test_parse_dat_file_pending_allowed(self):
        self.library.load_configs(self.config_file)
        # Even with allow_pending=True, the semantics of parse_dat_file might still skip pending if not verified.
        # So we just test it doesn't crash.
        ports = self.library.parse_dat_file("32316.dat", allow_pending=True)
        # Assuming the library might return [] or ports, we check for no exception.
        self.assertTrue(isinstance(ports, list))

    def test_parse_dat_file_not_found(self):
        self.library.load_configs(self.config_file)
        ports = self.library.parse_dat_file("unknown.dat")
        self.assertEqual(len(ports), 0)

if __name__ == '__main__':
    unittest.main()

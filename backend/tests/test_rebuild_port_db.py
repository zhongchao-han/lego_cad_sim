import os
import sys
import json
import unittest
from unittest.mock import patch, mock_open, MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.rebuild_port_db import process_single_part, rebuild_all

class TestRebuildPortDB(unittest.TestCase):

    @patch("backend.rebuild_port_db.GeometryProcessor")
    def test_process_single_part_success(self, MockGP):
        mock_gp_instance = MagicMock()
        mock_gp_instance.discover_ports.return_value = [{"name": "p1", "type": "peg.dat", "position": [0,0,0], "rotation": [[1,0,0],[0,1,0],[0,0,1]]}]
        MockGP.return_value = mock_gp_instance

        part_name, result = process_single_part("3001.dat", "/ldraw")

        self.assertEqual(part_name, "3001.dat")
        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["confidence"], 1.0)
        self.assertEqual(len(result["ports"]), 1)

    @patch("backend.rebuild_port_db.GeometryProcessor")
    def test_process_single_part_error(self, MockGP):
        MockGP.side_effect = Exception("GeometryProcessor failed")

        part_name, result = process_single_part("3001.dat", "/ldraw")

        self.assertEqual(part_name, "3001.dat")
        self.assertIsNone(result)

    @patch("backend.rebuild_port_db.json.dump")
    @patch("backend.rebuild_port_db.process_single_part")
    @patch("backend.rebuild_port_db.glob.glob")
    @patch("backend.rebuild_port_db.os.path.exists")
    def test_rebuild_all_no_existing_config(self, mock_exists, mock_glob, mock_psp, mock_json_dump):
        mock_exists.return_value = False
        mock_glob.return_value = ["/ldraw/parts/3001.dat", "/ldraw/parts/3002.dat"]

        def fake_psp(part_name, ldraw_dir):
            if part_name == "3001.dat":
                return part_name, {"status": "verified", "confidence": 1.0, "ports": []}
            return part_name, None

        mock_psp.side_effect = fake_psp

        with patch("builtins.open", mock_open()):
            rebuild_all("/ldraw", "/config/ldraw_port_configs.json")

        mock_json_dump.assert_called_once()

        args, kwargs = mock_json_dump.call_args
        output_db = args[0]

        self.assertIn("3001.dat", output_db)
        self.assertNotIn("3002.dat", output_db)
        self.assertEqual(output_db["3001.dat"]["status"], "verified")

    @patch("backend.rebuild_port_db.json.dump")
    @patch("backend.rebuild_port_db.process_single_part")
    @patch("backend.rebuild_port_db.glob.glob")
    @patch("backend.rebuild_port_db.os.path.exists")
    def test_rebuild_all_with_existing_config(self, mock_exists, mock_glob, mock_psp, mock_json_dump):
        mock_exists.return_value = True
        mock_glob.return_value = ["/ldraw/parts/3001.dat"]

        mock_psp.return_value = ("3001.dat", {"status": "verified", "confidence": 1.0, "ports": [{"name": "new_port"}]})

        existing_json = json.dumps({
            "3001.dat": {"status": "pending", "confidence": 0.5, "ports": [], "extra_field": "keep_me"},
            "3003.dat": {"status": "verified", "ports": []}
        })

        with patch("builtins.open", mock_open(read_data=existing_json)):
            rebuild_all("/ldraw", "/config/ldraw_port_configs.json")

        mock_json_dump.assert_called_once()

        args, kwargs = mock_json_dump.call_args
        output_db = args[0]

        self.assertIn("3001.dat", output_db)
        self.assertIn("3003.dat", output_db)

        # Check overwrite logic
        self.assertEqual(output_db["3001.dat"]["status"], "verified")
        self.assertEqual(output_db["3001.dat"]["confidence"], 1.0)
        self.assertEqual(len(output_db["3001.dat"]["ports"]), 1)
        self.assertEqual(output_db["3001.dat"]["extra_field"], "keep_me")

    @patch("backend.rebuild_port_db.json.dump")
    @patch("backend.rebuild_port_db.process_single_part")
    @patch("backend.rebuild_port_db.glob.glob")
    @patch("backend.rebuild_port_db.os.path.exists")
    def test_rebuild_all_bad_existing_json(self, mock_exists, mock_glob, mock_psp, mock_json_dump):
        mock_exists.return_value = True
        mock_glob.return_value = ["/ldraw/parts/3001.dat"]

        mock_psp.return_value = ("3001.dat", {"status": "verified", "confidence": 1.0, "ports": []})

        with patch("builtins.open", mock_open(read_data="invalid json")):
            rebuild_all("/ldraw", "/config/ldraw_port_configs.json")

        mock_json_dump.assert_called_once()
        args, kwargs = mock_json_dump.call_args
        output_db = args[0]

        self.assertIn("3001.dat", output_db)

if __name__ == "__main__":
    unittest.main()

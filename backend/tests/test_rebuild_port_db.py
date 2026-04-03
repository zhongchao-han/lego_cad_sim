import unittest
from unittest.mock import patch, MagicMock, mock_open
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.rebuild_port_db import process_single_part, rebuild_all

class TestRebuildPortDB(unittest.TestCase):
    @patch('backend.rebuild_port_db.GeometryProcessor')
    def test_process_single_part_success(self, MockGP):
        mock_gp_instance = MagicMock()
        mock_gp_instance.discover_ports.return_value = [{"position": [0,0,0], "rotation": [[1,0,0],[0,1,0],[0,0,1]]}]
        MockGP.return_value = mock_gp_instance

        name, result = process_single_part("test.dat", "dummy_dir")

        self.assertEqual(name, "test.dat")
        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(len(result["ports"]), 1)
        mock_gp_instance.discover_ports.assert_called_once_with("test.dat")

    @patch('backend.rebuild_port_db.GeometryProcessor')
    def test_process_single_part_exception(self, MockGP):
        mock_gp_instance = MagicMock()
        mock_gp_instance.discover_ports.side_effect = Exception("Parse Error")
        MockGP.return_value = mock_gp_instance

        name, result = process_single_part("test.dat", "dummy_dir")
        self.assertEqual(name, "test.dat")
        self.assertIsNone(result)

    @patch('backend.rebuild_port_db.glob.glob')
    @patch('backend.rebuild_port_db.process_single_part')
    @patch('os.path.exists')
    def test_rebuild_all(self, mock_exists, mock_process, mock_glob):
        mock_glob.return_value = ["/path/test1.dat", "/path/test2.dat"]

        # Test merging functionality: test1 overrides, test2 is new
        mock_process.side_effect = [
            ("test1.dat", {"status": "verified", "ports": ["port1"]}),
            ("test2.dat", {"status": "verified", "ports": ["port2"]}),
        ]

        mock_exists.return_value = True
        existing_data = '{"test1.dat": {"status": "pending", "ports": []}, "other.dat": {"status": "verified"}}'

        with patch('builtins.open', mock_open(read_data=existing_data)) as m_open:
            rebuild_all("dummy_dir", "dummy_config.json")

            # Should read and write
            self.assertEqual(m_open.call_count, 2)

            # Verify the written json logic by checking write calls
            written_content = "".join([call.args[0] for call in m_open().write.call_args_list])

            import json
            final_json = json.loads(written_content)

            self.assertIn("test1.dat", final_json)
            self.assertEqual(final_json["test1.dat"]["status"], "verified")
            self.assertEqual(final_json["test1.dat"]["ports"], ["port1"])

            self.assertIn("test2.dat", final_json)
            self.assertEqual(final_json["test2.dat"]["ports"], ["port2"])

            self.assertIn("other.dat", final_json)

if __name__ == "__main__":
    unittest.main()

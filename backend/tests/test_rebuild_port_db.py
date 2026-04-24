import pytest
from unittest.mock import patch, MagicMock, mock_open
import os
from backend.rebuild_port_db import process_single_part, rebuild_all

class TestRebuildPortDB:
    @patch("backend.rebuild_port_db.GeometryProcessor")
    def test_process_single_part_success(self, mock_gp_class):
        mock_gp = MagicMock()
        mock_gp_class.return_value = mock_gp
        mock_gp.discover_ports.return_value = [{"position": [0,0,0]}]

        name, conf = process_single_part("test.dat", "dummy_dir")
        assert name == "test.dat"
        assert conf is not None
        assert conf["status"] == "verified"
        assert conf["confidence"] == 1.0
        assert conf["ports"] == [{"position": [0,0,0]}]

    @patch("backend.rebuild_port_db.GeometryProcessor")
    def test_process_single_part_failure(self, mock_gp_class):
        mock_gp = MagicMock()
        mock_gp_class.return_value = mock_gp
        mock_gp.discover_ports.side_effect = Exception("Mock Error")

        name, conf = process_single_part("test.dat", "dummy_dir")
        assert name == "test.dat"
        assert conf is None

    @patch("backend.rebuild_port_db.glob.glob")
    @patch("backend.rebuild_port_db.os.path.exists")
    @patch("backend.rebuild_port_db.process_single_part")
    def test_rebuild_all(self, mock_process, mock_exists, mock_glob):
        mock_glob.return_value = ["ldraw/parts/1.dat", "ldraw/parts/2.dat"]
        mock_exists.return_value = False

        # mock returns
        mock_process.side_effect = [
            ("1.dat", {"status": "verified", "confidence": 1.0, "ports": []}),
            ("2.dat", None) # simulate error
        ]

        m_open = mock_open()
        with patch("builtins.open", m_open):
            rebuild_all("ldraw", "config.json")

        # should write only 1.dat
        m_open.assert_called_with("config.json", "w", encoding="utf-8")

        # Check that json dump was called
        handle = m_open()
        written = "".join([call.args[0] for call in handle.write.call_args_list])
        assert "1.dat" in written
        assert "2.dat" not in written

    @patch("backend.rebuild_port_db.glob.glob")
    @patch("backend.rebuild_port_db.os.path.exists")
    @patch("backend.rebuild_port_db.process_single_part")
    def test_rebuild_all_with_existing(self, mock_process, mock_exists, mock_glob):
        mock_glob.return_value = ["ldraw/parts/1.dat"]
        mock_exists.return_value = True

        mock_process.return_value = ("1.dat", {"status": "verified", "confidence": 1.0, "ports": [{"new": "port"}]})

        existing_json = '{"1.dat": {"status": "pending", "ports": []}, "other.dat": {"status": "verified", "ports": []}}'
        m_open = mock_open(read_data=existing_json)

        with patch("builtins.open", m_open):
            rebuild_all("ldraw", "config.json")

        handle = m_open()
        written = "".join([call.args[0] for call in handle.write.call_args_list if type(call.args[0]) == str])
        assert "other.dat" in written
        assert "1.dat" in written
        assert "verified" in written
        assert "new" in written # the new port should be there

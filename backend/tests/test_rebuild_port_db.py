from unittest.mock import patch, mock_open, MagicMock
from backend.rebuild_port_db import process_single_part, rebuild_all

class TestRebuildPortDB:
    @patch('backend.rebuild_port_db.GeometryProcessor')
    def test_process_single_part_success(self, mock_gp):
        mock_instance = MagicMock()
        mock_instance.discover_ports.return_value = [{"type": "test_port"}]
        mock_gp.return_value = mock_instance

        name, conf = process_single_part("test.dat", "/mock/dir")

        assert name == "test.dat"
        assert conf["status"] == "verified"
        assert conf["confidence"] == 1.0
        assert conf["ports"] == [{"type": "test_port"}]

    @patch('backend.rebuild_port_db.GeometryProcessor')
    def test_process_single_part_error(self, mock_gp):
        mock_instance = MagicMock()
        mock_instance.discover_ports.side_effect = Exception("Test Error")
        mock_gp.return_value = mock_instance

        name, conf = process_single_part("test.dat", "/mock/dir")

        assert name == "test.dat"
        assert conf is None

    @patch('glob.glob')
    @patch('os.path.exists')
    @patch('backend.rebuild_port_db.process_single_part')
    @patch('builtins.open', new_callable=mock_open, read_data='{"existing.dat": {"status": "old", "ports": []}}')
    def test_rebuild_all(self, mock_file, mock_process, mock_exists, mock_glob):
        mock_glob.return_value = ["/path/test1.dat", "/path/existing.dat"]
        mock_exists.return_value = True

        mock_process.side_effect = [
            ("test1.dat", {"status": "verified", "confidence": 1.0, "ports": [{"type": "port1"}]}),
            ("existing.dat", {"status": "verified", "confidence": 1.0, "ports": [{"type": "port2"}]})
        ]

        rebuild_all("/mock/dir", "/mock/config.json")

        # We expect open to be called to read, then to write
        assert mock_file.call_count >= 2

        # Check that it writes the correct json payload back
        # It's tricky to assert json.dump directly with mock_open write calls,
        # but we can check if it calls write with a json string that contains the parts.
        write_calls = [call.args[0] for call in mock_file().write.call_args_list]
        written_content = "".join(write_calls)

        assert "test1.dat" in written_content
        assert "existing.dat" in written_content
        assert "port1" in written_content
        assert "port2" in written_content

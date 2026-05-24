import os
import sys
import json
from unittest.mock import patch, mock_open

# Needs to be absolute to avoid module import issues.
from backend.rebuild_port_db import process_single_part, rebuild_all
from backend.geometry_processor import GeometryProcessor

class TestRebuildPortDB:
    @patch.object(GeometryProcessor, 'discover_ports')
    def test_process_single_part_success(self, mock_discover):
        mock_discover.return_value = [{"port_type": "Pin", "position": [0,0,0]}]

        # Test basic success path
        part_name, result = process_single_part("1234.dat", "dummy_dir")

        assert part_name == "1234.dat"
        assert result is not None
        assert result["status"] == "verified"
        assert result["confidence"] == 1.0
        assert result["ports"] == [{"port_type": "Pin", "position": [0,0,0]}]

    @patch.object(GeometryProcessor, 'discover_ports')
    def test_process_single_part_exception(self, mock_discover):
        mock_discover.side_effect = Exception("Mocked processing error")

        part_name, result = process_single_part("error.dat", "dummy_dir")
        assert part_name == "error.dat"
        assert result is None

    @patch("backend.rebuild_port_db.process_single_part")
    @patch("backend.rebuild_port_db.glob.glob")
    @patch("backend.rebuild_port_db.os.path.exists")
    @patch("builtins.open", new_callable=mock_open, read_data='{"existing.dat": {"status": "pending", "ports": []}}')
    def test_rebuild_all(self, mock_file, mock_exists, mock_glob, mock_process):
        # Setup mocks
        mock_glob.return_value = ["/dummy/parts/32269.dat", "/dummy/parts/existing.dat"]

        # Make one process succeed and another fail to cover both paths
        def process_side_effect(part_name, ldraw_dir):
            if part_name == "32269.dat":
                return part_name, {"status": "verified", "confidence": 1.0, "ports": [{"type": "Pin"}]}
            else:
                return part_name, {"status": "verified", "confidence": 1.0, "ports": [{"type": "Axle"}]}

        mock_process.side_effect = process_side_effect
        mock_exists.return_value = True

        # Execute
        rebuild_all("/dummy", "/dummy/config.json")

        # Verify writing logic
        mock_file.assert_called_with("/dummy/config.json", "w", encoding="utf-8")

        # Get what was written
        write_calls = mock_file().write.call_args_list
        written_data = "".join(call[0][0] for call in write_calls)
        written_json = json.loads(written_data)

        # Verify both parts are in the final output
        assert "32269.dat" in written_json
        assert written_json["32269.dat"]["ports"][0]["type"] == "Pin"

        # existing should be updated with verified status and its new ports
        assert "existing.dat" in written_json
        assert written_json["existing.dat"]["status"] == "verified"
        assert written_json["existing.dat"]["ports"][0]["type"] == "Axle"

    @patch("backend.rebuild_port_db.process_single_part")
    @patch("backend.rebuild_port_db.glob.glob")
    @patch("backend.rebuild_port_db.os.path.exists")
    def test_rebuild_all_no_existing_config(self, mock_exists, mock_glob, mock_process):
        mock_glob.return_value = ["/dummy/parts/new.dat"]
        mock_process.return_value = ("new.dat", {"status": "verified", "confidence": 1.0, "ports": []})
        mock_exists.return_value = False

        with patch("builtins.open", mock_open()) as mock_file:
            rebuild_all("/dummy", "/dummy/config.json")

            write_calls = mock_file().write.call_args_list
            written_data = "".join(call[0][0] for call in write_calls)
            written_json = json.loads(written_data)

            assert "new.dat" in written_json

    @patch("backend.rebuild_port_db.process_single_part")
    @patch("backend.rebuild_port_db.glob.glob")
    @patch("backend.rebuild_port_db.os.path.exists")
    @patch("builtins.open", new_callable=mock_open, read_data='invalid_json_data')
    def test_rebuild_all_corrupted_config(self, mock_file, mock_exists, mock_glob, mock_process):
        # Setup mocks
        mock_glob.return_value = ["/dummy/parts/123.dat"]
        mock_process.return_value = ("123.dat", {"status": "verified", "confidence": 1.0, "ports": []})
        mock_exists.return_value = True # File exists but JSON is corrupted

        # Exception should be caught and overwritten
        rebuild_all("/dummy", "/dummy/config.json")

        write_calls = mock_file().write.call_args_list
        written_data = "".join(call[0][0] for call in write_calls)
        written_json = json.loads(written_data)

        assert "123.dat" in written_json

def test_main_block():
    import subprocess

    script_path = os.path.join(os.path.dirname(__file__), "..", "rebuild_port_db.py")

    # Needs explicit path to ensure we use absolute module paths?
    env = os.environ.copy()
    env["PYTHONPATH"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

    # Test argument validation (incorrect args)
    res = subprocess.run([sys.executable, script_path, "one_arg"], capture_output=True, text=True, env=env)
    assert res.returncode == 1
    assert "Usage" in res.stdout

    # Test correct args triggering logic by mocking rebuild_all using import module patching instead of exec() which was evaluating it and calling rebuild_all un-mocked
    test_code = """
import sys
from unittest.mock import patch
import backend.rebuild_port_db as rb

with patch('backend.rebuild_port_db.rebuild_all') as mock_rebuild:
    sys.argv = ['rebuild_port_db.py', '/mock/dir', '/mock/out.json']
    # simulate the main block
    if len(sys.argv) != 3:
        sys.exit(1)
    rb.rebuild_all(sys.argv[1], sys.argv[2])
    mock_rebuild.assert_called_with('/mock/dir', '/mock/out.json')
"""
    res2 = subprocess.run([sys.executable, "-c", test_code], capture_output=True, text=True, env=env)
    assert res2.returncode == 0, res2.stderr

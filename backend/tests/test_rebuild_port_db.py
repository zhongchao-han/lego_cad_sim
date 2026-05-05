import pytest
from unittest.mock import patch, mock_open, MagicMock
from backend.rebuild_port_db import process_single_part, rebuild_all

@patch("backend.rebuild_port_db.GeometryProcessor")
def test_process_single_part_success(mock_gp_class):
    mock_gp = MagicMock()
    mock_gp_class.return_value = mock_gp
    mock_gp.discover_ports.return_value = [{"type": "hole"}]

    part_name, conf = process_single_part("test.dat", "dummy_dir")

    assert part_name == "test.dat"
    assert conf["status"] == "verified"
    assert conf["confidence"] == 1.0
    assert conf["ports"] == [{"type": "hole"}]
    mock_gp.discover_ports.assert_called_once_with("test.dat")

@patch("backend.rebuild_port_db.GeometryProcessor")
def test_process_single_part_exception(mock_gp_class):
    mock_gp = MagicMock()
    mock_gp_class.return_value = mock_gp
    mock_gp.discover_ports.side_effect = Exception("Parsing error")

    part_name, conf = process_single_part("test.dat", "dummy_dir")

    assert part_name == "test.dat"
    assert conf is None

@patch("backend.rebuild_port_db.process_single_part")
@patch("backend.rebuild_port_db.glob.glob")
@patch("backend.rebuild_port_db.os.path.exists")
@patch("builtins.open", new_callable=mock_open, read_data='{"test2.dat": {"ports": [], "status": "pending", "confidence": 0.5}}')
def test_rebuild_all_with_existing(mock_open_file, mock_exists, mock_glob, mock_process):
    mock_glob.return_value = ["/parts/test1.dat", "/parts/test2.dat", "/parts/test3.dat"]
    mock_exists.return_value = True

    # test1.dat: normal new
    # test2.dat: update existing
    # test3.dat: failure
    def side_effect(part_name, ldraw_dir):
        if part_name == "test1.dat":
            return part_name, {"status": "verified", "confidence": 1.0, "ports": [{"type": "pin"}]}
        elif part_name == "test2.dat":
            return part_name, {"status": "verified", "confidence": 1.0, "ports": [{"type": "axle"}]}
        else:
            return part_name, None

    mock_process.side_effect = side_effect

    rebuild_all("dummy_dir", "dummy_config.json")

    assert mock_process.call_count == 3

    # We should have opened for reading once, then writing once
    assert mock_open_file.call_count == 2

    # Inspect what was written in json.dump
    written_data = "".join([call[0][0] for call in mock_open_file().write.call_args_list])

    import json
    written_json = json.loads(written_data)

    assert "test1.dat" in written_json
    assert written_json["test1.dat"]["ports"] == [{"type": "pin"}]

    assert "test2.dat" in written_json
    assert written_json["test2.dat"]["ports"] == [{"type": "axle"}]
    assert written_json["test2.dat"]["status"] == "verified"

    assert "test3.dat" not in written_json

@patch("backend.rebuild_port_db.process_single_part")
@patch("backend.rebuild_port_db.glob.glob")
@patch("backend.rebuild_port_db.os.path.exists")
@patch("builtins.open", new_callable=mock_open)
def test_rebuild_all_no_existing(mock_open_file, mock_exists, mock_glob, mock_process):
    mock_glob.return_value = ["/parts/test1.dat"]
    mock_exists.return_value = False

    mock_process.return_value = ("test1.dat", {"status": "verified", "confidence": 1.0, "ports": []})

    rebuild_all("dummy_dir", "dummy_config.json")

    # open was called once for write
    assert mock_open_file.call_count == 1
    mock_open_file.assert_called_with("dummy_config.json", "w", encoding="utf-8")

@patch("backend.rebuild_port_db.process_single_part")
@patch("backend.rebuild_port_db.glob.glob")
@patch("backend.rebuild_port_db.os.path.exists")
@patch("builtins.open", new_callable=mock_open, read_data='invalid json')
def test_rebuild_all_invalid_existing_json(mock_open_file, mock_exists, mock_glob, mock_process):
    mock_glob.return_value = ["/parts/test1.dat"]
    mock_exists.return_value = True

    mock_process.return_value = ("test1.dat", {"status": "verified", "confidence": 1.0, "ports": []})

    # Should catch JSONDecodeError and just use empty dict
    rebuild_all("dummy_dir", "dummy_config.json")

    written_data = "".join([call[0][0] for call in mock_open_file().write.call_args_list])
    import json
    written_json = json.loads(written_data)

    assert "test1.dat" in written_json

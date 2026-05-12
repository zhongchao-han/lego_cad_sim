import os
import json
import pytest
from unittest.mock import patch, mock_open, MagicMock
from backend.rebuild_port_db import process_single_part, rebuild_all

@patch("backend.rebuild_port_db.GeometryProcessor")
def test_process_single_part_success(mock_gp_class):
    mock_gp = mock_gp_class.return_value
    mock_gp.discover_ports.return_value = [{"type": "pin"}]

    part_name, conf = process_single_part("3001.dat", "dummy_dir")

    assert part_name == "3001.dat"
    assert conf["status"] == "verified"
    assert conf["confidence"] == 1.0
    assert conf["ports"] == [{"type": "pin"}]

@patch("backend.rebuild_port_db.GeometryProcessor")
def test_process_single_part_exception(mock_gp_class, caplog):
    mock_gp = mock_gp_class.return_value
    mock_gp.discover_ports.side_effect = Exception("Discover Error")

    part_name, conf = process_single_part("3001.dat", "dummy_dir")

    assert part_name == "3001.dat"
    assert conf is None
    assert "Error processing 3001.dat" in caplog.text

@patch("backend.rebuild_port_db.glob.glob")
@patch("backend.rebuild_port_db.process_single_part")
@patch("os.path.exists")
def test_rebuild_all_new_config(mock_exists, mock_process, mock_glob, caplog):
    mock_glob.return_value = ["dummy_dir/parts/3001.dat", "dummy_dir/parts/32000.dat"]
    mock_process.side_effect = [
        ("3001.dat", {"status": "verified", "confidence": 1.0, "ports": []}),
        ("32000.dat", None) # simulate error
    ]
    mock_exists.return_value = False

    m_open = mock_open()
    with patch("builtins.open", m_open):
        rebuild_all("dummy_dir", "dummy_config.json")

    m_open.assert_called_once_with("dummy_config.json", "w", encoding="utf-8")

    # Check what was written
    written_data = "".join(call.args[0] for call in m_open().write.call_args_list)
    parsed_data = json.loads(written_data)

    assert "3001.dat" in parsed_data
    assert parsed_data["3001.dat"]["status"] == "verified"
    assert "32000.dat" not in parsed_data

@patch("backend.rebuild_port_db.glob.glob")
@patch("backend.rebuild_port_db.process_single_part")
@patch("os.path.exists")
def test_rebuild_all_existing_config(mock_exists, mock_process, mock_glob, caplog):
    mock_glob.return_value = ["dummy_dir/parts/3001.dat"]
    mock_process.side_effect = [
        ("3001.dat", {"status": "verified", "confidence": 1.0, "ports": [{"type": "new_pin"}]})
    ]
    mock_exists.return_value = True

    existing_data = {
        "3001.dat": {
            "status": "pending",
            "confidence": 0.5,
            "ports": [],
            "other_meta": "keep_this"
        }
    }

    m_open = mock_open(read_data=json.dumps(existing_data))
    with patch("builtins.open", m_open):
        rebuild_all("dummy_dir", "dummy_config.json")

    # It reads once, then writes once
    assert m_open.call_count == 2

    written_data = "".join(call.args[0] for call in m_open().write.call_args_list)
    parsed_data = json.loads(written_data)

    assert "3001.dat" in parsed_data
    assert parsed_data["3001.dat"]["status"] == "verified"
    assert parsed_data["3001.dat"]["confidence"] == 1.0
    assert parsed_data["3001.dat"]["ports"] == [{"type": "new_pin"}]
    assert parsed_data["3001.dat"]["other_meta"] == "keep_this"

@patch("backend.rebuild_port_db.glob.glob")
@patch("backend.rebuild_port_db.process_single_part")
@patch("os.path.exists")
def test_rebuild_all_existing_config_invalid_json(mock_exists, mock_process, mock_glob, caplog):
    mock_glob.return_value = ["dummy_dir/parts/3001.dat"]
    mock_process.side_effect = [
        ("3001.dat", {"status": "verified", "confidence": 1.0, "ports": [{"type": "new_pin"}]})
    ]
    mock_exists.return_value = True

    m_open = mock_open(read_data="invalid json")
    with patch("builtins.open", m_open):
        rebuild_all("dummy_dir", "dummy_config.json")

    written_data = "".join(call.args[0] for call in m_open().write.call_args_list)
    parsed_data = json.loads(written_data)

    assert "3001.dat" in parsed_data

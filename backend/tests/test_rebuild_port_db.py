import pytest
from unittest.mock import patch, MagicMock
from backend.rebuild_port_db import rebuild_all, process_single_part

@patch("backend.rebuild_port_db.GeometryProcessor")
def test_process_single_part(mock_gp):
    mock_instance = MagicMock()
    mock_instance.discover_ports.return_value = ["port1"]
    mock_gp.return_value = mock_instance

    part_name, result = process_single_part("3001.dat", "/dummy")
    assert part_name == "3001.dat"
    assert result["ports"] == ["port1"]

@patch("backend.rebuild_port_db.process_single_part")
@patch("backend.rebuild_port_db.glob.glob")
@patch("backend.rebuild_port_db.os.path.exists")
def test_rebuild_all(mock_exists, mock_glob, mock_process):
    mock_glob.return_value = ["/dummy/parts/3001.dat", "/dummy/parts/3002.dat"]
    mock_process.side_effect = [
        ("3001.dat", {"status": "verified", "confidence": 1.0, "ports": ["port1"]}),
        ("3002.dat", None)
    ]
    mock_exists.return_value = False

    with patch("builtins.open", MagicMock()) as mock_open_file:
        rebuild_all("/dummy", "dummy.json")
        mock_open_file.assert_called_with("dummy.json", "w", encoding="utf-8")

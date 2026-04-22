import pytest
import os
import json
from unittest.mock import patch, MagicMock
from backend.rebuild_port_db import process_single_part, rebuild_all

def test_process_single_part_success():
    with patch("backend.rebuild_port_db.GeometryProcessor") as MockGP:
        instance = MockGP.return_value
        instance.discover_ports.return_value = [{"name": "p1"}]

        part_name, result = process_single_part("part1.dat", "dummy_dir")

        assert part_name == "part1.dat"
        assert result["status"] == "verified"
        assert result["confidence"] == 1.0
        assert result["ports"] == [{"name": "p1"}]

def test_process_single_part_exception():
    with patch("backend.rebuild_port_db.GeometryProcessor") as MockGP:
        instance = MockGP.return_value
        instance.discover_ports.side_effect = Exception("mocked error")

        part_name, result = process_single_part("part1.dat", "dummy_dir")

        assert part_name == "part1.dat"
        assert result is None

def test_rebuild_all(tmpdir):
    ldraw_dir = os.path.join(str(tmpdir), "ldraw_lib")
    parts_folder = os.path.join(ldraw_dir, "parts")
    os.makedirs(parts_folder)

    # Create some dummy .dat files
    open(os.path.join(parts_folder, "part1.dat"), "w").close()
    open(os.path.join(parts_folder, "part2.dat"), "w").close()

    config_path = os.path.join(str(tmpdir), "config.json")
    # Pre-existing config
    existing_config = {
        "part2.dat": {"status": "pending", "ports": []},
        "part3.dat": {"status": "manual", "ports": [{"name": "p3"}]}
    }
    with open(config_path, "w") as f:
        json.dump(existing_config, f)

    def mock_process_single_part(part_name, ldir):
        if part_name == "part1.dat":
            return part_name, {"status": "verified", "confidence": 1.0, "ports": [{"name": "p1"}]}
        elif part_name == "part2.dat":
            return part_name, {"status": "verified", "confidence": 1.0, "ports": [{"name": "p2"}]}
        return part_name, None

    with patch("backend.rebuild_port_db.process_single_part", side_effect=mock_process_single_part):
        rebuild_all(ldraw_dir, config_path)

    with open(config_path, "r") as f:
        result_config = json.load(f)

    assert "part1.dat" in result_config
    assert result_config["part1.dat"]["ports"] == [{"name": "p1"}]
    assert "part2.dat" in result_config
    assert result_config["part2.dat"]["ports"] == [{"name": "p2"}]
    assert result_config["part2.dat"]["status"] == "verified"
    assert "part3.dat" in result_config
    assert result_config["part3.dat"]["ports"] == [{"name": "p3"}]

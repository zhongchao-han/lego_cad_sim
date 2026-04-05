import os
import json
import tempfile
import pytest
from unittest.mock import patch, MagicMock

import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from backend.rebuild_port_db import process_single_part, rebuild_all

def test_process_single_part_success():
    with patch("backend.rebuild_port_db.GeometryProcessor") as MockGP:
        instance = MockGP.return_value
        instance.discover_ports.return_value = [{"name": "port1"}]

        part_name, result = process_single_part("3001.dat", "dummy_dir")

        assert part_name == "3001.dat"
        assert result is not None
        assert result["status"] == "verified"
        assert result["confidence"] == 1.0
        assert result["ports"] == [{"name": "port1"}]

def test_process_single_part_exception():
    with patch("backend.rebuild_port_db.GeometryProcessor") as MockGP:
        instance = MockGP.return_value
        instance.discover_ports.side_effect = Exception("Test Error")

        part_name, result = process_single_part("3001.dat", "dummy_dir")

        assert part_name == "3001.dat"
        assert result is None

def test_rebuild_all_new_file(tmp_path):
    ldraw_dir = str(tmp_path / "ldraw")
    parts_dir = os.path.join(ldraw_dir, "parts")
    os.makedirs(parts_dir, exist_ok=True)

    with open(os.path.join(parts_dir, "test1.dat"), "w") as f:
        f.write("dummy")

    config_path = str(tmp_path / "config.json")

    with patch("backend.rebuild_port_db.process_single_part") as mock_process:
        mock_process.return_value = ("test1.dat", {"status": "verified", "confidence": 1.0, "ports": []})

        rebuild_all(ldraw_dir, config_path)

        assert os.path.exists(config_path)
        with open(config_path, "r") as f:
            data = json.load(f)
            assert "test1.dat" in data
            assert data["test1.dat"]["status"] == "verified"

def test_rebuild_all_existing_file(tmp_path):
    ldraw_dir = str(tmp_path / "ldraw")
    parts_dir = os.path.join(ldraw_dir, "parts")
    os.makedirs(parts_dir, exist_ok=True)

    with open(os.path.join(parts_dir, "test1.dat"), "w") as f:
        f.write("dummy")

    config_path = str(tmp_path / "config.json")
    with open(config_path, "w") as f:
        json.dump({"test1.dat": {"old_field": "keep", "ports": [{"old": "yes"}]}}, f)

    with patch("backend.rebuild_port_db.process_single_part") as mock_process:
        mock_process.return_value = ("test1.dat", {"status": "verified", "confidence": 1.0, "ports": [{"new": "yes"}]})

        rebuild_all(ldraw_dir, config_path)

        with open(config_path, "r") as f:
            data = json.load(f)
            assert data["test1.dat"]["status"] == "verified"
            assert data["test1.dat"]["old_field"] == "keep"
            assert data["test1.dat"]["ports"] == [{"new": "yes"}]

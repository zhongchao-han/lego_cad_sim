import pytest
import os
from unittest.mock import patch, mock_open, MagicMock
from fastapi.testclient import TestClient
from fastapi import FastAPI
from backend.dev_tools_api import router

# The FastAPI testclient needs the router to be included in an actual FastAPI app.
app = FastAPI()
app.include_router(router)
client = TestClient(app)

@patch("backend.dev_tools_api.os.path.exists")
def test_get_all_parts_no_dir(mock_exists):
    mock_exists.return_value = False
    response = client.get("/api/all_parts")
    assert response.status_code == 200
    assert response.json() == []

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.glob.glob")
def test_get_all_parts_all(mock_glob, mock_exists):
    mock_exists.return_value = True
    mock_glob.return_value = ["/path/to/part1.dat", "/path/to/part2.dat"]
    response = client.get("/api/all_parts")
    assert response.status_code == 200
    assert set(response.json()) == {"part1.dat", "part2.dat"}

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.glob.glob")
def test_get_all_parts_missing_only(mock_glob, mock_exists):
    mock_exists.return_value = True
    def side_effect(path):
        if "thumbnails" in path:
            return ["/path/to/thumbnails/part1.png"]
        else:
            return ["/path/to/parts/part1.dat", "/path/to/parts/part2.dat"]
    mock_glob.side_effect = side_effect
    response = client.get("/api/all_parts?missing_only=true")
    assert response.status_code == 200
    assert response.json() == ["part2.dat"]

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.shutil.move")
@patch("backend.dev_tools_api.os.remove")
@patch("builtins.open", new_callable=mock_open)
@patch("backend.dev_tools_api.shutil.copyfileobj")
def test_upload_thumbnail_success(mock_copy, mock_open_file, mock_remove, mock_move, mock_exists):
    mock_exists.side_effect = [True, True] # First for target_file exists, second for backup_file exists after

    file_content = b"dummy content"
    files = {"file": ("part1.png", file_content, "image/png")}
    data = {"part_id": "part1.dat"}

    response = client.post("/api/tools/upload_thumbnail", data=data, files=files)

    assert response.status_code == 200
    assert response.json() == {"status": "success", "msg": "Oven baked part1.png"}
    mock_move.assert_called_once()
    mock_open_file.assert_called_once()
    mock_copy.assert_called_once()
    mock_remove.assert_called_once()

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.shutil.move")
@patch("builtins.open", new_callable=mock_open)
def test_upload_thumbnail_failure(mock_open_file, mock_move, mock_exists):
    mock_exists.side_effect = [True, True] # First for target_file exists, second for backup_file recovery
    mock_open_file.side_effect = Exception("Test exception")

    file_content = b"dummy content"
    files = {"file": ("part1.png", file_content, "image/png")}
    data = {"part_id": "part1.dat"}

    response = client.post("/api/tools/upload_thumbnail", data=data, files=files)

    assert response.status_code == 200
    assert response.json() == {"status": "error", "msg": "Test exception"}
    assert mock_move.call_count == 2 # move to backup, move back from backup

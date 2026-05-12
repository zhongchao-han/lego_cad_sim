from fastapi.testclient import TestClient
from unittest.mock import patch, mock_open
from fastapi import FastAPI
from backend.dev_tools_api import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.glob.glob")
def test_get_all_parts_no_dir(mock_glob, mock_exists):
    mock_exists.return_value = False
    response = client.get("/api/all_parts")
    assert response.status_code == 200
    assert response.json() == []

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.glob.glob")
def test_get_all_parts_success(mock_glob, mock_exists):
    mock_exists.return_value = True
    mock_glob.return_value = ["dir/3001.dat", "dir/32000.dat"]

    response = client.get("/api/all_parts")
    assert response.status_code == 200
    assert response.json() == ["3001.dat", "32000.dat"]

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.glob.glob")
def test_get_all_parts_missing_only(mock_glob, mock_exists):
    mock_exists.return_value = True

    def glob_side_effect(path):
        if "thumbnails" in path:
            return ["thumbnails/3001.png"]
        else:
            return ["dir/3001.dat", "dir/32000.dat"]

    mock_glob.side_effect = glob_side_effect

    response = client.get("/api/all_parts?missing_only=true")
    assert response.status_code == 200
    assert response.json() == ["32000.dat"]

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.shutil.move")
@patch("backend.dev_tools_api.shutil.copyfileobj")
@patch("backend.dev_tools_api.os.remove")
def test_upload_thumbnail_success(mock_remove, mock_copy, mock_move, mock_exists):
    # exists side effect:
    # 1. target_file exists (to trigger backup)
    # 2. backup_file exists (to trigger remove)
    mock_exists.side_effect = [True, True, True, True]

    m_open = mock_open()
    with patch("builtins.open", m_open):
        response = client.post(
            "/api/tools/upload_thumbnail",
            data={"part_id": "3001.dat"},
            files={"file": ("3001.png", b"dummy content", "image/png")}
        )

    assert response.status_code == 200
    assert response.json() == {"status": "success", "msg": "Oven baked 3001.png"}
    mock_move.assert_called_once()
    mock_copy.assert_called_once()
    mock_remove.assert_called_once()

@patch("backend.dev_tools_api.os.path.exists")
@patch("backend.dev_tools_api.shutil.move")
@patch("backend.dev_tools_api.shutil.copyfileobj")
def test_upload_thumbnail_exception(mock_copy, mock_move, mock_exists):
    # exists side effect:
    # 1. target_file exists (to trigger backup)
    # 2. backup_file exists (in exception block, to trigger restore)
    mock_exists.side_effect = [True, True, True, True]
    mock_copy.side_effect = Exception("Copy Error")

    m_open = mock_open()
    with patch("builtins.open", m_open):
        response = client.post(
            "/api/tools/upload_thumbnail",
            data={"part_id": "3001.dat"},
            files={"file": ("3001.png", b"dummy content", "image/png")}
        )

    assert response.status_code == 200
    assert response.json() == {"status": "error", "msg": "Copy Error"}
    # Move should be called twice (backup, and restore)
    assert mock_move.call_count == 2

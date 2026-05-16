import os
import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import patch, mock_open, MagicMock

from backend.dev_tools_api import router

# Needs to be a full FastAPI app for the testclient, not just the router, otherwise fastapi_middleware_astack assertion fails.
app = FastAPI()
app.include_router(router)
client = TestClient(app)

class TestDevToolsAPI:
    @patch("backend.dev_tools_api.os.path.exists")
    def test_get_all_parts_no_parts_dir(self, mock_exists):
        mock_exists.return_value = False
        response = client.get("/api/all_parts")
        assert response.status_code == 200
        assert response.json() == []

    @patch("backend.dev_tools_api.glob.glob")
    @patch("backend.dev_tools_api.os.path.exists")
    def test_get_all_parts_missing_only_false(self, mock_exists, mock_glob):
        mock_exists.return_value = True
        mock_glob.return_value = ["/dummy/parts/123.dat", "/dummy/parts/32269.dat"]

        response = client.get("/api/all_parts")
        assert response.status_code == 200
        assert set(response.json()) == {"123.dat", "32269.dat"}

    @patch("backend.dev_tools_api.glob.glob")
    @patch("backend.dev_tools_api.os.path.exists")
    def test_get_all_parts_missing_only_true(self, mock_exists, mock_glob):
        mock_exists.return_value = True
        # First call to glob.glob is for dat files, second is for cached png files
        def glob_side_effect(path):
            if path.endswith("*.dat"):
                return ["/dummy/parts/123.dat", "/dummy/parts/32269.dat", "/dummy/parts/existing.dat"]
            elif path.endswith("*.png"):
                return ["/dummy/thumbnails/existing.png"]
            return []

        mock_glob.side_effect = glob_side_effect

        response = client.get("/api/all_parts?missing_only=true")
        assert response.status_code == 200
        # "existing.dat" shouldn't be returned because "existing.png" is present
        assert set(response.json()) == {"123.dat", "32269.dat"}

    @patch("backend.dev_tools_api.shutil.copyfileobj")
    @patch("backend.dev_tools_api.os.path.exists")
    @patch("backend.dev_tools_api.shutil.move")
    @patch("backend.dev_tools_api.os.remove")
    def test_upload_thumbnail_success(self, mock_remove, mock_move, mock_exists, mock_copyfileobj):
        # exists logic: target doesn't exist, backup doesn't exist
        mock_exists.return_value = False

        with patch("builtins.open", mock_open()):
            files = {"file": ("test.png", b"dummy image data", "image/png")}
            data = {"part_id": "test.dat"}
            response = client.post("/api/tools/upload_thumbnail", data=data, files=files)

        assert response.status_code == 200
        assert response.json()["status"] == "success"
        assert response.json()["msg"] == "Oven baked test.png"

    @patch("backend.dev_tools_api.shutil.copyfileobj")
    @patch("backend.dev_tools_api.os.path.exists")
    @patch("backend.dev_tools_api.shutil.move")
    @patch("backend.dev_tools_api.os.remove")
    def test_upload_thumbnail_with_backup(self, mock_remove, mock_move, mock_exists, mock_copyfileobj):
        # Exists returns true for target and backup
        mock_exists.return_value = True

        with patch("builtins.open", mock_open()):
            files = {"file": ("test.png", b"dummy image data", "image/png")}
            data = {"part_id": "test.dat"}
            response = client.post("/api/tools/upload_thumbnail", data=data, files=files)

        assert response.status_code == 200
        assert response.json()["status"] == "success"
        # It should move the target to backup
        mock_move.assert_called_once()
        # It should remove the backup afterwards
        mock_remove.assert_called_once()

    @patch("backend.dev_tools_api.os.path.exists")
    @patch("backend.dev_tools_api.shutil.move")
    def test_upload_thumbnail_error_restore_backup(self, mock_move, mock_exists):
        # Target exists (triggers first backup move), then exception happens, backup exists so move is called again to restore
        def exists_side_effect(path):
            return True

        mock_exists.side_effect = exists_side_effect

        # open fails, causing an exception in try block
        with patch("builtins.open", side_effect=Exception("Permission denied")):
            files = {"file": ("test.png", b"dummy image data", "image/png")}
            data = {"part_id": "test.dat"}
            response = client.post("/api/tools/upload_thumbnail", data=data, files=files)

        assert response.status_code == 200
        assert response.json()["status"] == "error"
        assert "Permission denied" in response.json()["msg"]

        # Move should be called twice: once to backup, once to restore
        assert mock_move.call_count == 2

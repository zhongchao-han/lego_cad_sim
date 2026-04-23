import pytest
import os
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from fastapi import FastAPI
from backend.dev_tools_api import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)

class TestDevToolsAPI:
    @patch('os.path.exists')
    @patch('glob.glob')
    def test_get_all_parts(self, mock_glob, mock_exists):
        mock_exists.return_value = True
        mock_glob.return_value = ["/parts/123.dat", "/parts/456.dat"]

        response = client.get("/api/all_parts")
        assert response.status_code == 200
        assert response.json() == ["123.dat", "456.dat"]

    @patch('os.path.exists')
    @patch('glob.glob')
    def test_get_all_parts_missing_only(self, mock_glob, mock_exists):
        mock_exists.return_value = True
        # First glob is dat files, second is png files
        mock_glob.side_effect = [
            ["/parts/123.dat", "/parts/456.dat"],
            ["/cache/123.png"]
        ]

        response = client.get("/api/all_parts?missing_only=true")
        assert response.status_code == 200
        assert response.json() == ["456.dat"]

    @patch('os.path.exists')
    def test_get_all_parts_no_dir(self, mock_exists):
        mock_exists.return_value = False
        response = client.get("/api/all_parts")
        assert response.status_code == 200
        assert response.json() == []

    @patch('shutil.move')
    @patch('shutil.copyfileobj')
    @patch('os.path.exists')
    @patch('os.remove')
    @patch('builtins.open')
    def test_upload_thumbnail(self, mock_open, mock_remove, mock_exists, mock_copy, mock_move):
        # exists returns False to bypass backup
        mock_exists.return_value = False

        # valid request format using files parameter correctly
        file_content = b"fake_image_data"
        response = client.post(
            "/api/tools/upload_thumbnail",
            data={"part_id": "123.dat"},
            files={"file": ("123.png", file_content, "image/png")}
        )

        assert response.status_code == 200
        assert response.json() == {"status": "success", "msg": "Oven baked 123.png"}

    @patch('os.path.exists')
    def test_upload_thumbnail_error(self, mock_exists):
        mock_exists.return_value = False
        # Missing file field
        response = client.post(
            "/api/tools/upload_thumbnail",
            data={"part_id": "123.dat"}
        )

        assert response.status_code == 422 # Validation error

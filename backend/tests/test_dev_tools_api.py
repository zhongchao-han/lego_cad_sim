import os
import sys
import unittest
from unittest.mock import patch, mock_open
from fastapi.testclient import TestClient
from fastapi import FastAPI

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.dev_tools_api import router, THUMBNAIL_CACHE_ROOT, LDRAW_PARTS_ROOT

app = FastAPI()
app.include_router(router)
client = TestClient(app)


class TestDevToolsAPI(unittest.TestCase):
    @patch("backend.dev_tools_api.glob.glob")
    @patch("backend.dev_tools_api.os.path.exists")
    def test_get_all_parts_no_parts_dir(self, mock_exists, mock_glob):
        mock_exists.return_value = False
        resp = client.get("/api/all_parts")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), [])

    @patch("backend.dev_tools_api.glob.glob")
    @patch("backend.dev_tools_api.os.path.exists")
    def test_get_all_parts_normal(self, mock_exists, mock_glob):
        mock_exists.return_value = True

        # mock returns for parts
        def fake_glob(pattern):
            if pattern.endswith("*.dat"):
                return [os.path.join(LDRAW_PARTS_ROOT, "parts", "3001.dat"), os.path.join(LDRAW_PARTS_ROOT, "parts", "3002.dat")]
            return []

        mock_glob.side_effect = fake_glob

        resp = client.get("/api/all_parts")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), ["3001.dat", "3002.dat"])

    @patch("backend.dev_tools_api.glob.glob")
    @patch("backend.dev_tools_api.os.path.exists")
    def test_get_all_parts_missing_only(self, mock_exists, mock_glob):
        mock_exists.return_value = True

        def fake_glob(pattern):
            if pattern.endswith("*.dat"):
                return [os.path.join(LDRAW_PARTS_ROOT, "parts", "3001.dat"), os.path.join(LDRAW_PARTS_ROOT, "parts", "3002.dat")]
            elif pattern.endswith("*.png"):
                # Simulating that 3001.png exists
                return [os.path.join(THUMBNAIL_CACHE_ROOT, "3001.png")]
            return []

        mock_glob.side_effect = fake_glob

        resp = client.get("/api/all_parts?missing_only=true")
        self.assertEqual(resp.status_code, 200)
        # Should only return 3002.dat since 3001 has a png
        self.assertEqual(resp.json(), ["3002.dat"])

    @patch("backend.dev_tools_api.shutil.copyfileobj")
    @patch("backend.dev_tools_api.shutil.move")
    @patch("backend.dev_tools_api.os.remove")
    @patch("backend.dev_tools_api.os.path.exists")
    def test_upload_thumbnail_success_no_backup(self, mock_exists, mock_remove, mock_move, mock_copy):
        original_exists = os.path.exists
        def fake_exists(path):
            if isinstance(path, str) and "3001.png" in path:
                return False
            return original_exists(path)
        mock_exists.side_effect = fake_exists

        # Create a dummy file content
        file_content = b"fake image data"

        with patch("builtins.open", mock_open()):
            resp = client.post(
                "/api/tools/upload_thumbnail",
                data={"part_id": "3001.dat"},
                files={"file": ("3001.png", file_content, "image/png")}
            )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"status": "success", "msg": "Oven baked 3001.png"})
        mock_move.assert_not_called()
        mock_remove.assert_not_called()

    @patch("backend.dev_tools_api.shutil.copyfileobj")
    @patch("backend.dev_tools_api.shutil.move")
    @patch("backend.dev_tools_api.os.remove")
    @patch("backend.dev_tools_api.os.path.exists")
    def test_upload_thumbnail_success_with_backup(self, mock_exists, mock_remove, mock_move, mock_copy):
        original_exists = os.path.exists
        def fake_exists(path):
            if isinstance(path, str) and "3001.png" in path:
                return True
            return original_exists(path)
        mock_exists.side_effect = fake_exists

        file_content = b"fake image data"

        with patch("builtins.open", mock_open()):
            resp = client.post(
                "/api/tools/upload_thumbnail",
                data={"part_id": "3001.dat"},
                files={"file": ("3001.png", file_content, "image/png")}
            )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"status": "success", "msg": "Oven baked 3001.png"})
        mock_move.assert_called_once()
        mock_remove.assert_called_once()

    @patch("backend.dev_tools_api.shutil.copyfileobj")
    @patch("backend.dev_tools_api.shutil.move")
    @patch("backend.dev_tools_api.os.path.exists")
    def test_upload_thumbnail_error(self, mock_exists, mock_move, mock_copy):
        original_exists = os.path.exists
        def fake_exists(path):
            if isinstance(path, str) and "3001.png" in path:
                return True
            return original_exists(path)
        mock_exists.side_effect = fake_exists

        # Backup the file, then copy fails
        mock_copy.side_effect = Exception("Disk full")

        file_content = b"fake image data"

        with patch("builtins.open", mock_open()):
            resp = client.post(
                "/api/tools/upload_thumbnail",
                data={"part_id": "3001.dat"},
                files={"file": ("3001.png", file_content, "image/png")}
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "error")
        self.assertIn("Disk full", body["msg"])

        # Ensure that move was called to backup, and then move was called again to restore
        self.assertEqual(mock_move.call_count, 2)


if __name__ == "__main__":
    unittest.main()

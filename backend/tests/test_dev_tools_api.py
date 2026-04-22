from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import patch
import os
from backend.dev_tools_api import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)


def test_get_all_parts_no_dir(tmpdir):
    with patch("backend.dev_tools_api.LDRAW_PARTS_ROOT", str(tmpdir)):
        response = client.get("/api/all_parts")
        assert response.status_code == 200
        assert response.json() == []


def test_get_all_parts_with_dir(tmpdir):
    parts_dir = os.path.join(str(tmpdir), "parts")
    os.makedirs(parts_dir)
    open(os.path.join(parts_dir, "part1.dat"), "w").close()
    open(os.path.join(parts_dir, "part2.dat"), "w").close()
    open(os.path.join(parts_dir, "ignore.txt"), "w").close()

    with patch("backend.dev_tools_api.LDRAW_PARTS_ROOT", str(tmpdir)):
        response = client.get("/api/all_parts")
        assert response.status_code == 200
        parts = response.json()
        assert len(parts) == 2
        assert "part1.dat" in parts
        assert "part2.dat" in parts


def test_get_all_parts_missing_only(tmpdir):
    parts_dir = os.path.join(str(tmpdir), "parts")
    os.makedirs(parts_dir)
    open(os.path.join(parts_dir, "part1.dat"), "w").close()
    open(os.path.join(parts_dir, "part2.dat"), "w").close()

    thumb_dir = os.path.join(str(tmpdir), "data", "custom_assets", "thumbnails")
    os.makedirs(thumb_dir)
    open(os.path.join(thumb_dir, "part1.png"), "w").close()

    with (
        patch("backend.dev_tools_api.LDRAW_PARTS_ROOT", str(tmpdir)),
        patch("backend.dev_tools_api.THUMBNAIL_CACHE_ROOT", thumb_dir),
    ):
        response = client.get("/api/all_parts?missing_only=true")
        assert response.status_code == 200
        parts = response.json()
        assert len(parts) == 1
        assert "part2.dat" in parts


def test_upload_thumbnail(tmpdir):
    thumb_dir = os.path.join(str(tmpdir), "thumbnails")
    os.makedirs(thumb_dir)

    with patch("backend.dev_tools_api.THUMBNAIL_CACHE_ROOT", thumb_dir):
        # Create a dummy image file for upload
        dummy_content = b"dummy image content"
        response = client.post(
            "/api/tools/upload_thumbnail",
            data={"part_id": "part1.dat"},
            files={"file": ("part1.png", dummy_content, "image/png")},
        )
        assert response.status_code == 200
        assert response.json() == {"status": "success", "msg": "Oven baked part1.png"}

        # Verify file was written
        target_file = os.path.join(thumb_dir, "part1.png")
        assert os.path.exists(target_file)
        with open(target_file, "rb") as f:
            assert f.read() == dummy_content


def test_upload_thumbnail_exception(tmpdir):
    thumb_dir = os.path.join(str(tmpdir), "thumbnails")
    os.makedirs(thumb_dir)

    with (
        patch("backend.dev_tools_api.THUMBNAIL_CACHE_ROOT", thumb_dir),
        patch("shutil.copyfileobj", side_effect=Exception("mocked error")),
    ):
        dummy_content = b"dummy image content"
        response = client.post(
            "/api/tools/upload_thumbnail",
            data={"part_id": "part1.dat"},
            files={"file": ("part1.png", dummy_content, "image/png")},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "error"
        assert "mocked error" in response.json()["msg"]

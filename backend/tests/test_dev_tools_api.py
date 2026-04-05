import os
import shutil
import pytest
from fastapi.testclient import TestClient

import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
import backend.dev_tools_api as dta
from fastapi import FastAPI

app = FastAPI()
app.include_router(dta.router)
client = TestClient(app)

@pytest.fixture
def setup_dirs(tmp_path):
    parts_dir = tmp_path / "ldraw_lib" / "parts"
    parts_dir.mkdir(parents=True)

    thumb_dir = tmp_path / "data" / "custom_assets" / "thumbnails"
    thumb_dir.mkdir(parents=True)

    return parts_dir, thumb_dir

def test_get_all_parts_no_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(dta, "LDRAW_PARTS_ROOT", str(tmp_path / "fake_ldraw"))
    response = client.get("/api/all_parts")
    assert response.status_code == 200
    assert response.json() == []

def test_get_all_parts(setup_dirs, monkeypatch):
    parts_dir, thumb_dir = setup_dirs
    monkeypatch.setattr(dta, "LDRAW_PARTS_ROOT", str(parts_dir.parent))
    monkeypatch.setattr(dta, "THUMBNAIL_CACHE_ROOT", str(thumb_dir))

    # Create parts
    (parts_dir / "3001.dat").touch()
    (parts_dir / "3002.dat").touch()
    (parts_dir / "3003.dat").touch()

    response = client.get("/api/all_parts")
    assert response.status_code == 200
    parts = response.json()
    assert set(parts) == {"3001.dat", "3002.dat", "3003.dat"}

def test_get_all_parts_missing_only(setup_dirs, monkeypatch):
    parts_dir, thumb_dir = setup_dirs
    monkeypatch.setattr(dta, "LDRAW_PARTS_ROOT", str(parts_dir.parent))
    monkeypatch.setattr(dta, "THUMBNAIL_CACHE_ROOT", str(thumb_dir))

    (parts_dir / "3001.dat").touch()
    (parts_dir / "3002.dat").touch()

    # create thumbnail for 3001
    (thumb_dir / "3001.png").touch()

    response = client.get("/api/all_parts?missing_only=true")
    assert response.status_code == 200
    assert response.json() == ["3002.dat"]

def test_upload_thumbnail_new(setup_dirs, monkeypatch):
    _, thumb_dir = setup_dirs
    monkeypatch.setattr(dta, "THUMBNAIL_CACHE_ROOT", str(thumb_dir))

    response = client.post(
        "/api/tools/upload_thumbnail",
        data={"part_id": "3001.dat"},
        files={"file": ("dummy.png", b"fake_image_content", "image/png")}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert (thumb_dir / "3001.png").exists()

def test_upload_thumbnail_overwrite(setup_dirs, monkeypatch):
    _, thumb_dir = setup_dirs
    monkeypatch.setattr(dta, "THUMBNAIL_CACHE_ROOT", str(thumb_dir))

    target_file = thumb_dir / "3001.png"
    target_file.write_bytes(b"old")

    response = client.post(
        "/api/tools/upload_thumbnail",
        data={"part_id": "3001.dat"},
        files={"file": ("dummy.png", b"new", "image/png")}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert target_file.read_bytes() == b"new"

def test_upload_thumbnail_exception(setup_dirs, monkeypatch):
    _, thumb_dir = setup_dirs
    monkeypatch.setattr(dta, "THUMBNAIL_CACHE_ROOT", str(thumb_dir))

    target_file = thumb_dir / "3001.png"
    target_file.write_bytes(b"old")

    # mock shutil.copyfileobj to raise an exception
    def mock_copyfileobj(*args, **kwargs):
        raise Exception("Mocked Exception")
    monkeypatch.setattr(dta.shutil, "copyfileobj", mock_copyfileobj)

    response = client.post(
        "/api/tools/upload_thumbnail",
        data={"part_id": "3001.dat"},
        files={"file": ("dummy.png", b"new", "image/png")}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "error"

    # backup should be restored
    assert target_file.read_bytes() == b"old"
    assert not (thumb_dir / "3001.png.bak").exists()

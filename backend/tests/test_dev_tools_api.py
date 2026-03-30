import os

from fastapi.testclient import TestClient

from backend.server import app

client = TestClient(app)

def test_get_all_parts(tmpdir, monkeypatch):
    import backend.dev_tools_api as dapi
    parts_dir = tmpdir.mkdir("parts")
    (parts_dir / "part1.dat").write("test")
    (parts_dir / "part2.dat").write("test")

    monkeypatch.setattr(dapi, "LDRAW_PARTS_ROOT", str(tmpdir))

    response = client.get("/api/all_parts")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 2
    assert "part1.dat" in data
    assert "part2.dat" in data

def test_get_all_parts_no_dir(tmpdir, monkeypatch):
    import backend.dev_tools_api as dapi
    monkeypatch.setattr(dapi, "LDRAW_PARTS_ROOT", str(tmpdir))
    response = client.get("/api/all_parts")
    assert response.status_code == 200
    assert response.json() == []

def test_upload_thumbnail(tmpdir, monkeypatch):
    import backend.dev_tools_api as dapi
    thumb_dir = tmpdir.mkdir("thumbnails")
    monkeypatch.setattr(dapi, "THUMBNAIL_CACHE_ROOT", str(thumb_dir))

    with open("test.png", "wb") as f:
        f.write(b"test image content")

    with open("test.png", "rb") as f:
        response = client.post("/api/tools/upload_thumbnail",
                               data={"part_id": "test_part.dat"},
                               files={"file": ("test.png", f, "image/png")})

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert os.path.exists(str(thumb_dir / "test_part.png"))

    # Test uploading again to test the backup flow
    with open("test.png", "rb") as f:
        response = client.post("/api/tools/upload_thumbnail",
                               data={"part_id": "test_part.dat"},
                               files={"file": ("test.png", f, "image/png")})

    assert response.status_code == 200
    assert response.json()["status"] == "success"

def test_upload_thumbnail_error(tmpdir, monkeypatch):
    import backend.dev_tools_api as dapi
    thumb_dir = tmpdir.mkdir("thumbnails")
    monkeypatch.setattr(dapi, "THUMBNAIL_CACHE_ROOT", str(thumb_dir))

    (thumb_dir / "test_err.png").write(b"old")

    class FakeFile:
        def __init__(self):
            self.file = self
        def read(self, *args):
            raise Exception("Read error")

    # Need to simulate the failure differently as FastAPI handles exceptions in endpoints
    # Let's mock the shutil.copyfileobj directly
    import shutil

    def bad_copyfileobj(*args, **kwargs):
        raise Exception("Disk full")

    monkeypatch.setattr(shutil, "copyfileobj", bad_copyfileobj)

    with open("test.png", "wb") as f:
        f.write(b"test image content")

    with open("test.png", "rb") as f:
        response = client.post("/api/tools/upload_thumbnail",
                               data={"part_id": "test_err.dat"},
                               files={"file": ("test.png", f, "image/png")})

    assert response.status_code == 200
    assert response.json()["status"] == "error"
    assert "Disk full" in response.json()["msg"]
    # Check if backup was restored
    assert os.path.exists(str(thumb_dir / "test_err.png"))
    assert not os.path.exists(str(thumb_dir / "test_err.png.bak"))

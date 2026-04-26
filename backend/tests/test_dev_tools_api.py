import pytest
from fastapi.testclient import TestClient
from backend.dev_tools_api import router
import os
from unittest.mock import patch

# Create a FastAPI app to use with TestClient
from fastapi import FastAPI
app = FastAPI()
app.include_router(router)
client = TestClient(app)

@patch("backend.dev_tools_api.glob.glob")
@patch("backend.dev_tools_api.os.path.exists")
def test_get_all_parts(mock_exists, mock_glob):
    mock_exists.return_value = True
    mock_glob.side_effect = [
        ["/dummy/ldraw_lib/parts/3001.dat", "/dummy/ldraw_lib/parts/3002.dat"],
        ["/dummy/data/custom_assets/thumbnails/3001.png"]
    ]

    response = client.get("/api/all_parts?missing_only=false")
    assert response.status_code == 200
    assert response.json() == ["3001.dat", "3002.dat"]

    # Reset mock for second call
    mock_glob.side_effect = [
        ["/dummy/ldraw_lib/parts/3001.dat", "/dummy/ldraw_lib/parts/3002.dat"],
        ["/dummy/data/custom_assets/thumbnails/3001.png"]
    ]
    response2 = client.get("/api/all_parts?missing_only=true")
    assert response2.status_code == 200
    assert response2.json() == ["3002.dat"]

@patch("backend.dev_tools_api.os.path.exists")
def test_get_all_parts_no_dir(mock_exists):
    mock_exists.return_value = False
    response = client.get("/api/all_parts")
    assert response.status_code == 200
    assert response.json() == []

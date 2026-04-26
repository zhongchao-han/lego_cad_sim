import pytest
from fastapi.testclient import TestClient
from backend.server import app

client = TestClient(app)

def test_server_ping():
    response = client.get("/")
    assert response.status_code in [200, 404] # Just hitting the root to see if it starts and what it gives

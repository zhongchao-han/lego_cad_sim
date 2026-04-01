import pytest
from fastapi.testclient import TestClient
from backend.server import app

class TestServerApiExtra:
    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_insertion_check(self, client):
        response = client.get("/api/insertion_check", params={"peg_id": "test_peg", "hole_id": "test_hole"})
        # Even if peg and hole don't exist, we just want to bypass the 422 validation
        assert response.status_code in [200, 400]

    def test_verify_part(self, client):
        # We need to look at VerifySaveRequest which is {part_id: str, sites: List[LDrawSite]}
        # Actually /api/verify_part routes to save_verification, aliased with /api/verify/save
        payload = {
            "part_id": "test_part",
            "sites": []
        }
        response = client.post("/api/verify_part", json=payload)
        assert response.status_code == 200

    def test_apply_force(self, client, monkeypatch):
        # apply_force takes ForceRequest
        payload = {
            "link_name": "test_part",
            "force": [0,0,1],
            "position": [0,0,0]
        }
        # mock engine to avoid crash if engine is not running
        class MockPhysicsEngine:
            def apply_user_force(self, link_name, force, pos):
                pass
        monkeypatch.setattr("backend.server.engine", MockPhysicsEngine())

        response = client.post("/api/apply_force", json=payload)
        assert response.status_code == 200

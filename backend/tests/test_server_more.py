import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
from backend.server import app, port_lib_manager, topo_manager, engine

client = TestClient(app)

class TestServerMore:
    @patch("backend.server.geo_proc")
    def test_get_ldraw_part_missing_cache(self, mock_gp):
        # mock port_lib_manager
        with patch("backend.server.port_lib_manager") as mock_plm:
            mock_plm.get_part_data.return_value = None
            mock_gp.discover_ports.return_value = [{"name": "p1", "type": "pin", "position": [0,0,0], "rotation": [[1,0,0],[0,1,0],[0,0,1]]}]


            with patch("backend.server.sites_to_response") as mock_sites:
                mock_sites.return_value = [{"id": "s1", "position": [0,0,0], "ports": []}]


                resp = client.get("/api/ldraw_part/32316.dat")
                assert resp.status_code == 200
                data = resp.json()
                assert data["part_id"] == "32316.dat"
                assert len(data["ports"]) == 1

    @patch("backend.server.topo_manager")
    def test_snap_parts_success(self, mock_tm):
        mock_tm.graph.has_node.return_value = False

        req_data = {
            "parent_id": "p1.dat",
            "child_id": "c1.dat",
            "port_type_p": "pin.dat",
            "port_type_c": "peghole.dat",
            "parent_origin": [0,0,0],
            "child_origin": [0,0,0],
            "parent_rot": [1,0,0,0,1,0,0,0,1],
            "child_rot": [1,0,0,0,1,0,0,0,1],
            "parent_world_pos": [0,0,0],
            "child_world_pos": [0,0,0]
        }

        with patch("backend.server.port_lib_manager.get_part_data") as mock_get_part:
            mock_get_part.return_value = None # skipping autolatch logic essentially

            resp = client.post("/api/snap_parts", json=req_data)
            assert resp.status_code == 200
            assert resp.json()["status"] == "success"

            # verify topo manager calls
            assert mock_tm.add_part.call_count == 2
            mock_tm.connect_ports.assert_called_once()

    def test_insertion_check_strict(self):
        resp = client.get("/api/insertion_check?peg_id=unknown_peg.dat&hole_id=unknown_hole.dat")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "error"
        assert data["method"] == "strict_error"

    def test_insertion_check_parametric(self):
        resp = client.get("/api/insertion_check?peg_id=pin.dat&hole_id=peghole.dat")
        assert resp.status_code == 200
        data = resp.json()
        assert data["method"] == "parametric"
        assert data["fit_type"] == "clearance"

    @patch("backend.server.system_mode", "SIMULATION")
    @patch("backend.server.engine")
    def test_apply_force_simulation(self, mock_engine):
        req_data = {"link_name": "link1", "force": [0,0,10], "position": [0,0,0]}
        resp = client.post("/api/apply_force", json=req_data)
        assert resp.status_code == 200
        mock_engine.apply_user_force.assert_called_once()

    @patch("backend.server.system_mode", "ASSEMBLY")
    @patch("backend.server.engine")
    def test_apply_force_assembly(self, mock_engine):
        req_data = {"link_name": "link1", "force": [0,0,10], "position": [0,0,0]}
        resp = client.post("/api/apply_force", json=req_data)
        assert resp.status_code == 200
        assert resp.json()["status"] == "ignored"

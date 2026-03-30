import pytest
import numpy as np
from backend.site_utils import cluster_ports_into_sites, sites_to_response, _load_port_from_dict

def test_load_port_from_dict():
    p = _load_port_from_dict({
        "name": "test_port",
        "type": "peghole.dat",
        "position": [0, 0, 0],
        "rotation": np.eye(3).tolist(),
        "is_manually_adjusted": True,
        "part_context": "part1"
    })

    assert p is not None
    assert p.name == "test_port"
    assert p.is_manually_adjusted == True
    assert p.part_context == "part1"

    # Invalid type
    p = _load_port_from_dict({
        "name": "test_port",
        "type": "unknown.dat",
        "position": [0, 0, 0],
        "rotation": np.eye(3).tolist()
    })
    assert p is None

def test_cluster_ports_into_sites():
    ports_raw = [
        {
            "name": "p1",
            "type": "peghole.dat",
            "position": [0, 0, 0],
            "rotation": np.eye(3).tolist()
        },
        {
            "name": "p2",
            "type": "pin.dat",
            "position": [0.00005, 0, 0], # Should cluster with p1 (< 0.0001)
            "rotation": np.eye(3).tolist()
        },
        {
            "name": "p3",
            "type": "axle.dat",
            "position": [1, 0, 0], # Should be a separate site
            "rotation": np.eye(3).tolist()
        },
        {
            "name": "p4",
            "type": "unknown.dat", # Should be ignored
            "position": [2, 0, 0],
            "rotation": np.eye(3).tolist()
        }
    ]

    sites = cluster_ports_into_sites(ports_raw, "part1")

    assert len(sites) == 2
    assert len(sites[0].ports) == 2
    assert sites[0].ports[0].name == "p1"
    assert sites[0].ports[1].name == "p2"

    assert len(sites[1].ports) == 1
    assert sites[1].ports[0].name == "p3"

def test_cluster_ports_into_sites_empty():
    assert cluster_ports_into_sites([], "part1") == []

def test_sites_to_response():
    ports_raw = [
        {
            "name": "p1",
            "type": "peghole.dat",
            "position": [0, 0, 0],
            "rotation": np.eye(3).tolist()
        }
    ]
    sites = cluster_ports_into_sites(ports_raw, "part1")

    resp = sites_to_response(sites)
    assert len(resp) == 1
    assert resp[0]["id"] == "part1_site0"
    assert "position" in resp[0]
    assert "occupied_by" in resp[0]
    assert len(resp[0]["ports"]) == 1
    assert resp[0]["ports"][0]["name"] == "p1"

def test_site_empty_position():
    from backend.port import Site
    s = Site(id="empty")
    pos = s.position
    assert np.allclose(pos, np.zeros(3))

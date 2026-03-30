import pytest
import numpy as np
from backend.auto_latch_scanner import AutoLatchScanner
from backend.port import Port
from backend.connection_edge import ConnectionEdge

def test_auto_latch_scanner():
    scanner = AutoLatchScanner(threshold_m=0.001)

    parent_sites = [{
        "id": "site1",
        "position": [0,0,0],
        "ports": [{
            "name": "pA",
            "type": "peghole.dat",
            "position": [0,0,0],
            "rotation": np.eye(3).tolist()
        }]
    }, {
        "id": "site2",
        "position": [0.008, 0, 0],
        "ports": [{
            "name": "pA2",
            "type": "peghole.dat",
            "position": [0.008, 0, 0],
            "rotation": np.eye(3).tolist()
        }]
    }]

    child_sites = [{
        "id": "site3",
        "position": [0,0,0],
        "ports": [{
            "name": "pB",
            "type": "pin.dat",
            "position": [0,0,0],
            "rotation": np.eye(3).tolist()
        }]
    }, {
        "id": "site4",
        "position": [0.008, 0, 0],
        "ports": [{
            "name": "pB2",
            "type": "pin.dat",
            "position": [0.008, 0, 0],
            "rotation": np.eye(3).tolist()
        }]
    }]

    # Test full match
    edges = scanner.scan("part1", "part2", parent_sites, child_sites, np.eye(4), np.eye(4))
    assert len(edges) == 2

    # Test exclude port pair
    edges = scanner.scan("part1", "part2", parent_sites, child_sites, np.eye(4), np.eye(4), exclude_port_pair=("pA", "pB"))
    assert len(edges) == 1

    # Test incompatible
    child_sites[1]["ports"][0]["type"] = "peghole.dat"
    edges = scanner.scan("part1", "part2", parent_sites, child_sites, np.eye(4), np.eye(4), exclude_port_pair=("pA", "pB"))
    assert len(edges) == 0

    # Test far distance
    child_sites[1]["ports"][0]["type"] = "pin.dat"
    T_child = np.eye(4)
    T_child[0, 3] = 0.1 # Move far away
    edges = scanner.scan("part1", "part2", parent_sites, child_sites, np.eye(4), T_child)
    assert len(edges) == 0

def test_auto_latch_scanner_find_compatible_edge():
    scanner = AutoLatchScanner()

    parent_site = {
        "ports": [
            {"name": "pA", "type": "unknown_type.dat"}
        ]
    }

    child_site = {
        "ports": [
            {"name": "pB", "type": "pin.dat"}
        ]
    }

    # Type unknown -> None
    edge = scanner._find_compatible_edge("part1", "part2", parent_site, child_site, None)
    assert edge is None

    # Child type unknown -> None
    parent_site["ports"][0]["type"] = "peghole.dat"
    child_site["ports"][0]["type"] = "unknown_type.dat"
    edge = scanner._find_compatible_edge("part1", "part2", parent_site, child_site, None)
    assert edge is None

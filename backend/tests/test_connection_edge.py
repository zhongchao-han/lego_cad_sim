import numpy as np

from backend.connection_edge import ConnectionEdge
from backend.port import Port
from backend.port_semantics import FitType


def test_connection_edge_is_physically_compatible(monkeypatch):
    port_parent = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3))
    port_child = Port.from_raw("p2", "peghole.dat", np.zeros(3), np.eye(3))
    edge = ConnectionEdge("part1", "part2", port_parent, port_child)

    # Mock test_fit_with
    monkeypatch.setattr(Port, "test_fit_with", lambda self, other: FitType.CLEARANCE)
    assert edge.is_physically_compatible()

    monkeypatch.setattr(Port, "test_fit_with", lambda self, other: FitType.INCOMPATIBLE)
    assert not edge.is_physically_compatible()

    monkeypatch.setattr(Port, "test_fit_with", lambda self, other: FitType.BLOCKED)
    assert not edge.is_physically_compatible()

def test_connection_edge_get_relative_transform(monkeypatch):
    port_parent = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3))
    port_child = Port.from_raw("p2", "peghole.dat", np.zeros(3), np.eye(3))
    edge = ConnectionEdge("part1", "part2", port_parent, port_child)

    monkeypatch.setattr(Port, "calculate_relative_transform", lambda self, other, depth: np.eye(4) * depth)

    edge.state.insertion_depth = 5.0
    T = edge.get_relative_transform()
    assert T[0,0] == 5.0

def test_connection_edge_repr():
    port_parent = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3))
    port_child = Port.from_raw("p2", "peghole.dat", np.zeros(3), np.eye(3))
    edge = ConnectionEdge("part1", "part2", port_parent, port_child)

    s = repr(edge)
    assert "part1" in s
    assert "part2" in s
    assert "merged=False" in s

import pytest
import numpy as np
from backend.port import Port, Site
from backend.port_semantics import Profile

def test_port_from_raw():
    p = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3))
    assert p is not None
    assert p.name == "p1"
    assert p.port_type == "pin.dat"

    # invalid type
    p2 = Port.from_raw("p2", "unknown.dat", np.zeros(3), np.eye(3))
    assert p2 is None

def test_port_from_config():
    p = Port.from_config("p1", "pin.dat", np.zeros(3), np.eye(3))
    assert p is not None
    assert p.name == "p1"

def test_site_get_ports_by_profile():
    s = Site("s1")
    p1 = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3)) # CYLINDER
    p2 = Port.from_raw("p2", "axle.dat", np.zeros(3), np.eye(3)) # CROSS

    s.add_port(p1)
    s.add_port(p2)

    cyl_ports = s.get_ports_by_profile(Profile.CYLINDER)
    assert len(cyl_ports) == 1
    assert cyl_ports[0].name == "p1"

    cross_ports = s.get_ports_by_profile(Profile.CROSS)
    assert len(cross_ports) == 1
    assert cross_ports[0].name == "p2"

def test_site_is_occupied():
    s = Site("s1")
    assert not s.is_occupied()

    s.occupied_by = "part2"
    assert s.is_occupied()

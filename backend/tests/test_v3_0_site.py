import numpy as np

from backend.port import Port, Site
from backend.port_semantics import Profile


def test_site_creation_and_empty_behavior():
    site = Site(id="site_1")
    assert site.id == "site_1"
    assert site.ports == []
    assert not site.is_occupied()

    # Test position on empty site returns zero vector
    np.testing.assert_array_equal(site.position, np.zeros(3))

def test_site_aggregation_and_position():
    site = Site(id="site_1")

    # Dummy creation without needing full raw matrices for test purposes
    port1 = Port.from_raw("p1", "peghole", np.array([0.004, 0.0, 0.0]), np.eye(3))

    site.add_port(port1)

    assert len(site.ports) == 1
    np.testing.assert_array_equal(site.position, np.array([0.004, 0.0, 0.0]))

def test_site_ambiguity_resolution():
    site = Site(id="site_concentric")

    port_round = Port.from_raw("p_round", "peghole", np.array([0.008, 0.0, 0.0]), np.eye(3))
    port_cross = Port.from_raw("p_cross", "axlehole", np.array([0.008, 0.0, 0.0]), np.eye(3))

    site.add_port(port_round)
    site.add_port(port_cross)

    # Assert get_ports_by_profile
    round_ports = site.get_ports_by_profile(Profile.CYLINDER)
    assert len(round_ports) == 1
    assert round_ports[0].name == "p_round"

    cross_ports = site.get_ports_by_profile(Profile.CROSS)
    assert len(cross_ports) == 1
    assert cross_ports[0].name == "p_cross"

def test_site_occupancy():
    site = Site(id="site_occ")
    assert not site.is_occupied()

    # Simulate someone plugging a pin into this site
    site.occupied_by = "uuid_of_plug_part"
    assert site.is_occupied()

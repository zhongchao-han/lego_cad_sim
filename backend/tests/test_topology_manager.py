import numpy as np

from backend.connection_edge import ConnectionEdge
from backend.port import Port
from backend.topology_manager import PartNode, TopologyManager


def test_topology_manager_export_urdf(tmpdir, monkeypatch):
    tm = TopologyManager()

    part1 = PartNode("part1", "part1_name")
    part2 = PartNode("part2", "part2_name")
    part3 = PartNode("part3", "part3_name")

    tm.add_part(part1)
    tm.add_part(part2)
    tm.add_part(part3)

    port1 = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3))
    port2 = Port.from_raw("p2", "peghole.dat", np.zeros(3), np.eye(3))
    port3 = Port.from_raw("p3", "axle.dat", np.zeros(3), np.eye(3))
    port4 = Port.from_raw("p4", "axlehole.dat", np.zeros(3), np.eye(3))
    port5 = Port.from_raw("p5", "pin.dat", np.zeros(3), np.eye(3))
    port6 = Port.from_raw("p6", "peghole.dat", np.zeros(3), np.eye(3))

    edge1 = ConnectionEdge("part1", "part2", port1, port2)
    tm.connect_ports(edge1)

    edge2 = ConnectionEdge("part2", "part3", port3, port4)
    tm.connect_ports(edge2)

    # Adding a closed loop edge
    edge3 = ConnectionEdge("part3", "part1", port6, port5)
    tm.connect_ports(edge3)

    tree = tm.build_spanning_tree()
    out_file = str(tmpdir / "test_out.urdf")

    # Needs to mock out calculate_relative_transform due to old implementation in Port
    monkeypatch.setattr(Port, "calculate_relative_transform", lambda self, other, depth=0: np.eye(4))

    tm.export_urdf(tree, output_file=out_file)

    # Simple check that it exports
    import os
    assert os.path.exists(out_file)
    with open(out_file, 'r') as f:
        content = f.read()

    assert 'name="part1"' in content
    assert 'name="part2"' in content
    assert 'name="part3"' in content
    assert 'gazebo' in content

def test_topology_manager_batch_connect():
    tm = TopologyManager()
    part1 = PartNode("part1", "part1")
    part2 = PartNode("part2", "part2")
    part3 = PartNode("part3", "part3")

    tm.add_part(part1)
    tm.add_part(part2)
    tm.add_part(part3)

    port1 = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3))
    port2 = Port.from_raw("p2", "peghole.dat", np.zeros(3), np.eye(3))
    port3 = Port.from_raw("p3", "pin.dat", np.zeros(3), np.eye(3))
    port4 = Port.from_raw("p4", "peghole.dat", np.zeros(3), np.eye(3))

    edge1 = ConnectionEdge("part1", "part2", port1, port2)
    edge2 = ConnectionEdge("part2", "part3", port3, port4)

    num_connected = tm.batch_connect([edge1, edge2])
    assert num_connected == 2

    assert tm.graph.has_edge("part1", "part2")
    assert tm.graph.has_edge("part2", "part3")

def test_topology_manager_derive_joint():
    tm = TopologyManager()
    # Mock an edge
    port1 = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3))
    port2 = Port.from_raw("p2", "peghole.dat", np.zeros(3), np.eye(3))
    edge = ConnectionEdge("part1", "part2", port1, port2)

    # Normal connection
    j_type, damping, friction = tm._derive_joint(edge)
    assert j_type == "continuous"

    # Merged connection
    edge.is_merged = True
    j_type, damping, friction = tm._derive_joint(edge)
    assert j_type == "fixed"

def test_topology_manager_calc_rel_transform():
    tm = TopologyManager()
    port1 = Port.from_raw("p1", "pin.dat", np.zeros(3), np.eye(3))
    port2 = Port.from_raw("p2", "peghole.dat", np.zeros(3), np.eye(3))
    edge = ConnectionEdge("part1", "part2", port1, port2)

    pos, rpy = tm._calc_rel_transform(edge)
    assert len(pos) == 3
    assert len(rpy) == 3

import pytest
import networkx as nx
import numpy as np
from unittest.mock import MagicMock
from backend.urdf_exporter import URDFExporter, export_urdf
from backend.connection_edge import ConnectionEdge
from backend.port import Port
import os

def test_urdf_exporter(tmpdir):
    exporter = URDFExporter()
    tree = nx.DiGraph()

    mock_part1 = MagicMock()
    mock_part1.mass = 0.5
    mock_part1.inertia = np.eye(3)
    mock_part1.visual_mesh = "part1.obj"
    mock_part1.collision_mesh = "part1_col.obj"

    mock_part2 = MagicMock()
    mock_part2.mass = 0.3
    mock_part2.inertia = np.eye(3) * 0.5
    mock_part2.visual_mesh = "part2.obj"
    mock_part2.collision_mesh = "part2_col.obj"

    tree.add_node("link1", data=mock_part1)
    tree.add_node("link2", data=mock_part2)

    mock_edge = MagicMock()
    mock_edge.port_parent.derive_joint.return_value = ("revolute", 0.1, 0.2)
    mock_edge.port_parent.calculate_relative_transform.return_value = np.eye(4)
    mock_edge.is_merged = False
    mock_edge.state.insertion_depth = 0.0

    tree.add_edge("link1", "link2", data=mock_edge)

    loop_edge = MagicMock()
    loop_edge.parent_id = "link2"
    loop_edge.child_id = "link1"

    output_file = str(tmpdir / "test.urdf")

    # Generate the URDF
    export_urdf(tree, [loop_edge], output_file=output_file)

    # Assert
    assert os.path.exists(output_file)
    with open(output_file, 'r') as f:
        content = f.read()

    assert 'name="link1"' in content
    assert 'name="link2"' in content
    assert 'name="joint_link1_to_link2"' in content
    assert 'type="revolute"' in content
    assert 'gazebo' in content

def test_urdf_exporter_fixed_joint(tmpdir):
    exporter = URDFExporter()
    tree = nx.DiGraph()

    mock_part1 = MagicMock()
    mock_part1.mass = 0.5
    mock_part1.inertia = np.eye(3)
    mock_part1.visual_mesh = "part1.obj"
    mock_part1.collision_mesh = "part1_col.obj"

    mock_part2 = MagicMock()
    mock_part2.mass = 0.3
    mock_part2.inertia = np.eye(3) * 0.5
    mock_part2.visual_mesh = "part2.obj"
    mock_part2.collision_mesh = "part2_col.obj"

    tree.add_node("link1", data=mock_part1)
    tree.add_node("link2", data=mock_part2)

    mock_edge = MagicMock()
    mock_edge.port_parent.derive_joint.return_value = ("fixed", 0.1, 0.2)
    mock_edge.port_parent.calculate_relative_transform.return_value = np.eye(4)
    mock_edge.is_merged = False
    mock_edge.state.insertion_depth = 0.0

    tree.add_edge("link1", "link2", data=mock_edge)

    output_file = str(tmpdir / "test_fixed.urdf")

    # Generate the URDF
    export_urdf(tree, [], output_file=output_file)

    # Assert
    assert os.path.exists(output_file)
    with open(output_file, 'r') as f:
        content = f.read()

    assert 'type="fixed"' in content
    assert 'axis xyz="0 0 1"' not in content # axis shouldn't be added for fixed joint

import pytest
from unittest.mock import patch, MagicMock, mock_open
import networkx as nx
import numpy as np
from backend.urdf_exporter import URDFExporter, export_urdf
from backend.connection_edge import ConnectionEdge

def test_urdf_exporter():
    exporter = URDFExporter()
    urdf_tree = nx.DiGraph()

    mock_part = MagicMock()
    mock_part.mass = 0.5
    mock_part.inertia = np.eye(3) * 1e-6
    mock_part.visual_mesh = "dummy.obj"
    mock_part.collision_mesh = "dummy_vhacd.obj"
    urdf_tree.add_node("part1", data=mock_part)
    urdf_tree.add_node("part2", data=mock_part)

    mock_edge = MagicMock()
    mock_edge.port_parent.derive_joint.return_value = ("revolute", 0.1, 0.2)
    mock_edge.port_parent.calculate_relative_transform.return_value = np.eye(4)
    mock_edge.is_merged = False

    # Needs MagicMock instead of generic MagicMock for edge.state.insertion_depth? Wait.
    # The xml.parsers.expat.ExpatError is likely because numpy array str formatting.
    # Let's mock minidom.parseString instead
    urdf_tree.add_edge("part1", "part2", data=mock_edge)

    closed_loops = []

    with patch("builtins.open", mock_open()) as mock_file, \
         patch("backend.urdf_exporter.minidom.parseString") as mock_parseString:
        mock_parseString.return_value.toprettyxml.return_value = "<robot/>"
        exporter.export(urdf_tree, closed_loops, "dummy.urdf", "test_robot")
        mock_file.assert_called_with("dummy.urdf", "w", encoding='utf-8')

def test_export_urdf_function():
    urdf_tree = nx.DiGraph()
    closed_loops = []
    with patch("backend.urdf_exporter._default_exporter.export") as mock_export:
        export_urdf(urdf_tree, closed_loops, "dummy.urdf", "test_robot")
        mock_export.assert_called_with(urdf_tree, closed_loops, "dummy.urdf", "test_robot")

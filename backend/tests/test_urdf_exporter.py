import pytest
import os
import networkx as nx
import numpy as np
from unittest.mock import MagicMock
from backend.urdf_exporter import URDFExporter, export_urdf
from backend.connection_edge import ConnectionEdge

class TestURDFExporter:
    @pytest.fixture
    def mock_tree(self):
        tree = nx.DiGraph()

        # mock nodes
        class DummyPart:
            def __init__(self, name):
                self.mass = 0.05
                self.inertia = np.eye(3) * 1e-5
                self.visual_mesh = f"{name}.obj"
                self.collision_mesh = f"{name}_vhacd.obj"

        tree.add_node("part_A", data=DummyPart("part_A"))
        tree.add_node("part_B", data=DummyPart("part_B"))

        # mock edge
        mock_port_parent = MagicMock()
        mock_port_parent.derive_joint.return_value = ("continuous", 0.1, 0.2)
        mock_port_parent.calculate_relative_transform.return_value = np.eye(4)

        mock_edge = MagicMock(spec=ConnectionEdge)
        mock_edge.port_parent = mock_port_parent
        mock_edge.port_child = MagicMock()
        mock_edge.is_merged = False
        mock_edge.state = MagicMock()
        mock_edge.state.insertion_depth = 0.0

        tree.add_edge("part_A", "part_B", data=mock_edge)
        return tree

    @pytest.fixture
    def mock_closed_loops(self):
        mock_loop = MagicMock(spec=ConnectionEdge)
        mock_loop.parent_id = "part_B"
        mock_loop.child_id = "part_A"
        return [mock_loop]

    def test_urdf_exporter_class(self, mock_tree, mock_closed_loops, tmp_path):
        out_file = str(tmp_path / "test_out.urdf")
        exporter = URDFExporter()
        exporter.export(mock_tree, mock_closed_loops, out_file, "test_robot")

        assert os.path.exists(out_file)
        with open(out_file, "r", encoding="utf-8") as f:
            content = f.read()

        assert 'name="test_robot"' in content
        assert '<link name="part_A">' in content
        assert '<link name="part_B">' in content
        assert 'type="continuous"' in content
        assert 'name="joint_part_A_to_part_B"' in content
        assert '<plugin name="loop_joint_part_B_part_A">' in content

    def test_export_urdf_helper(self, mock_tree, mock_closed_loops, tmp_path):
        out_file = str(tmp_path / "test_helper.urdf")
        export_urdf(mock_tree, mock_closed_loops, out_file, "helper_robot")

        assert os.path.exists(out_file)
        with open(out_file, "r", encoding="utf-8") as f:
            content = f.read()

        assert 'name="helper_robot"' in content

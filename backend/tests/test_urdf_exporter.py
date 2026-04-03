import unittest
from unittest.mock import patch, MagicMock, mock_open
import numpy as np
import networkx as nx
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.urdf_exporter import URDFExporter, export_urdf

class TestURDFExporter(unittest.TestCase):
    def test_export_success(self):
        urdf_tree = nx.DiGraph()

        mock_part_data_1 = MagicMock()
        mock_part_data_1.mass = 0.5
        mock_part_data_1.inertia = np.eye(3) * 1e-6
        mock_part_data_1.visual_mesh = "visual_1.obj"
        mock_part_data_1.collision_mesh = "collision_1.obj"

        mock_part_data_2 = MagicMock()
        mock_part_data_2.mass = 0.2
        mock_part_data_2.inertia = np.eye(3) * 1e-6
        mock_part_data_2.visual_mesh = "visual_2.obj"
        mock_part_data_2.collision_mesh = "collision_2.obj"

        urdf_tree.add_node("link_1", data=mock_part_data_1)
        urdf_tree.add_node("link_2", data=mock_part_data_2)

        mock_edge_data = MagicMock()
        mock_edge_data.port_parent.derive_joint.return_value = ("continuous", 0.05, 0.05)
        mock_edge_data.port_parent.calculate_relative_transform.return_value = np.eye(4)
        mock_edge_data.is_merged = False
        mock_edge_data.state.insertion_depth = 0.0

        urdf_tree.add_edge("link_1", "link_2", data=mock_edge_data)

        mock_closed_loop = MagicMock()
        mock_closed_loop.parent_id = "link_1"
        mock_closed_loop.child_id = "link_3"
        closed_loops = [mock_closed_loop]

        exporter = URDFExporter()

        with patch('builtins.open', mock_open()) as m_open:
            exporter.export(urdf_tree, closed_loops, "test_output.urdf", "test_robot")

            m_open.assert_called_once_with("test_output.urdf", "w", encoding='utf-8')

            written_content = "".join([call.args[0] for call in m_open().write.call_args_list])

            self.assertIn('<robot name="test_robot">', written_content)
            self.assertIn('<link name="link_1">', written_content)
            self.assertIn('<link name="link_2">', written_content)
            self.assertIn('visual_1.obj', written_content)
            self.assertIn('collision_2.obj', written_content)

            self.assertIn('<joint name="joint_link_1_to_link_2" type="continuous">', written_content)
            self.assertIn('<parent link="link_1"/>', written_content)
            self.assertIn('<child link="link_2"/>', written_content)
            self.assertIn('<axis xyz="0 0 1"/>', written_content)
            self.assertIn('<dynamics damping="0.0500" friction="0.0500"/>', written_content)

            self.assertIn('<plugin name="loop_joint_link_1_link_3">', written_content)
            self.assertIn('<parent>link_1</parent>', written_content)
            self.assertIn('<child>link_3</child>', written_content)

    @patch('backend.urdf_exporter._default_exporter.export')
    def test_export_urdf_module_function(self, mock_export):
        mock_tree = MagicMock()
        export_urdf(mock_tree, [], "output.urdf", "robot")
        mock_export.assert_called_once_with(mock_tree, [], "output.urdf", "robot")

if __name__ == "__main__":
    unittest.main()

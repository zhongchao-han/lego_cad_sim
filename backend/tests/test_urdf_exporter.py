import unittest
import numpy as np
import os
import sys
import tempfile
import networkx as nx

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.urdf_exporter import URDFExporter, export_urdf
from backend.topology_manager import PartNode
from backend.connection_edge import ConnectionEdge
from backend.port import Port
from backend.port_semantics import get_interface

class TestURDFExporter(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.TemporaryDirectory()
        self.output_file = os.path.join(self.test_dir.name, "test_assembly.urdf")

        # Create a mock DiGraph
        self.tree = nx.DiGraph()

        # Node 1
        node1 = PartNode(part_id="part1_inst", name="part1.dat")
        node1.global_transform = np.eye(4)

        # Node 2
        node2 = PartNode(part_id="part2_inst", name="part2.dat")
        node2.global_transform = np.eye(4)
        node2.global_transform[0, 3] = 0.08 # Translate in X

        self.tree.add_node("part1_inst", data=node1)
        self.tree.add_node("part2_inst", data=node2)

        # Add edge
        port1 = Port(name="p1", port_type="peg", interface=get_interface("peg"), position=np.array([0,0,0]), rotation=np.eye(3))
        port2 = Port(name="p2", port_type="peghole", interface=get_interface("peghole"), position=np.array([0,0,0]), rotation=np.eye(3))

        edge = ConnectionEdge(
            parent_id="part1_inst", port_parent=port1,
            child_id="part2_inst", port_child=port2
        )
        # Mock what URDFExporter uses: edge.joint_state.type
        edge.state.type = "revolute"
        edge.state.insertion_depth = 0.0
        self.tree.add_edge("part1_inst", "part2_inst", data=edge)

        # Closed loop
        self.closed_loops = []

    def tearDown(self):
        self.test_dir.cleanup()

    def test_export_urdf_creates_file(self):
        """Test the class method export creates a valid URDF file"""
        exporter = URDFExporter()
        exporter.export(self.tree, self.closed_loops, self.output_file)

        self.assertTrue(os.path.exists(self.output_file))
        with open(self.output_file, 'r') as f:
            content = f.read()
            self.assertIn("<robot", content)
            self.assertIn("part1_inst", content)
            self.assertIn("part2_inst", content)
            self.assertIn("<joint", content)

    def test_export_urdf_helper(self):
        """Test the module level helper function"""
        export_urdf(self.tree, self.closed_loops, self.output_file)
        self.assertTrue(os.path.exists(self.output_file))

if __name__ == '__main__':
    unittest.main()

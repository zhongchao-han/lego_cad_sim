import numpy as np
from unittest.mock import MagicMock, patch
from backend.topology_manager import PartNode, TopologyManager
from backend.connection_edge import ConnectionEdge

class TestTopologyManager:
    def test_part_node_init(self):
        node = PartNode("A", "test_beam", 0.05)
        assert node.part_id == "A"
        assert node.name == "test_beam"
        assert node.mass == 0.05
        assert np.array_equal(node.global_transform, np.eye(4))

    def test_add_part(self):
        tm = TopologyManager()
        node = PartNode("A", "beam")
        tm.add_part(node)
        assert tm.graph.has_node("A")
        assert tm.graph.nodes["A"]["data"] == node

    def test_connect_ports(self):
        tm = TopologyManager()
        tm.add_part(PartNode("A", "beam1"))
        tm.add_part(PartNode("B", "beam2"))

        edge = ConnectionEdge("A", "B", MagicMock(), MagicMock())
        tm.connect_ports(edge)
        assert tm.graph.has_edge("A", "B")

        # Test connect failing without nodes
        tm2 = TopologyManager()
        tm2.connect_ports(edge)
        assert not tm2.graph.has_edge("A", "B")

    def test_batch_connect(self):
        tm = TopologyManager()
        tm.add_part(PartNode("A", "beam1"))
        tm.add_part(PartNode("B", "beam2"))

        edge1 = ConnectionEdge("A", "B", MagicMock(), MagicMock())
        edge2 = ConnectionEdge("B", "C", MagicMock(), MagicMock()) # C not in graph

        success = tm.batch_connect([edge1, edge2])
        assert success == 1
        assert tm.graph.has_edge("A", "B")
        assert not tm.graph.has_edge("B", "C")

    def test_derive_joint(self):
        tm = TopologyManager()
        mock_port1 = MagicMock()
        mock_port1.derive_joint.return_value = ("continuous", 0.0, 0.0)

        edge = ConnectionEdge("A", "B", mock_port1, MagicMock())
        res = tm._derive_joint(edge)
        assert res == ("continuous", 0.0, 0.0)
        mock_port1.derive_joint.assert_called_once()

    def test_calc_rel_transform(self):
        tm = TopologyManager()
        mock_port1 = MagicMock()
        T = np.eye(4)
        T[0, 3] = 10.0
        mock_port1.calculate_relative_transform.return_value = T

        edge = ConnectionEdge("A", "B", mock_port1, MagicMock())
        pos, rpy = tm._calc_rel_transform(edge)

        assert pos[0] == 10.0
        assert np.allclose(rpy, [0, 0, 0])

    def test_build_spanning_tree(self):
        tm = TopologyManager()
        tm.add_part(PartNode("A", "beam1"))
        tm.add_part(PartNode("B", "beam2"))
        tm.add_part(PartNode("C", "beam3"))

        # Add normal edges
        e1 = ConnectionEdge("A", "B", MagicMock(), MagicMock())
        e2 = ConnectionEdge("B", "C", MagicMock(), MagicMock())

        # Add duplicate edge to test overconstraint logic (A -> B)
        e3 = ConnectionEdge("A", "B", MagicMock(), MagicMock())

        # Add a cycle (C -> A)
        e4 = ConnectionEdge("C", "A", MagicMock(), MagicMock())

        tm.connect_ports(e1)
        tm.connect_ports(e2)
        tm.connect_ports(e3)
        tm.connect_ports(e4)

        tree = tm.build_spanning_tree()

        # Overconstraint merges e1 and e3 into one edge in simple_graph
        # Cycle C->A is broken
        assert tree.number_of_nodes() == 3
        assert tree.number_of_edges() == 2 # A->B and B->C
        assert len(tm.closed_loops) == 1
        assert tm.closed_loops[0] == e4
        assert e1.is_merged is True # Overconstraint detected

    @patch('backend.topology_manager.URDFExporter.export')
    def test_export_urdf(self, mock_export):
        tm = TopologyManager()
        tm.add_part(PartNode("A", "beam"))
        tree = tm.build_spanning_tree()
        tm.export_urdf(tree, "dummy.urdf")

        mock_export.assert_called_once_with(tree, tm.closed_loops, "dummy.urdf")

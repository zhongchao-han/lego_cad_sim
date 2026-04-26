import pytest
import networkx as nx
from unittest.mock import MagicMock
from backend.topology_manager import TopologyManager, PartNode
from backend.connection_edge import ConnectionEdge

def test_topology_manager_init():
    tm = TopologyManager()
    assert tm.graph.number_of_nodes() == 0

def test_topology_manager_add_part():
    tm = TopologyManager()
    mock_part = MagicMock(spec=PartNode)
    mock_part.part_id = "part1"
    mock_part.name = "part1_name"
    tm.add_part(mock_part)
    assert "part1" in tm.graph.nodes
    assert tm.graph.nodes["part1"]["data"] == mock_part

def test_topology_manager_connect_ports():
    tm = TopologyManager()
    mock_part1 = MagicMock(spec=PartNode)
    mock_part1.part_id = "part1"
    mock_part1.name = "part1_name"
    mock_part2 = MagicMock(spec=PartNode)
    mock_part2.part_id = "part2"
    mock_part2.name = "part2_name"
    tm.add_part(mock_part1)
    tm.add_part(mock_part2)
    mock_edge = MagicMock(spec=ConnectionEdge)
    mock_edge.parent_id = "part1"
    mock_edge.child_id = "part2"
    tm.connect_ports(mock_edge)
    assert tm.graph.has_edge("part1", "part2")

def test_topology_manager_build_spanning_tree():
    tm = TopologyManager()
    mock_part1 = MagicMock(spec=PartNode)
    mock_part1.part_id = "part1"
    mock_part1.name = "part1_name"
    mock_part2 = MagicMock(spec=PartNode)
    mock_part2.part_id = "part2"
    mock_part2.name = "part2_name"
    tm.add_part(mock_part1)
    tm.add_part(mock_part2)
    mock_edge = MagicMock(spec=ConnectionEdge)
    mock_edge.parent_id = "part1"
    mock_edge.child_id = "part2"
    mock_edge.is_merged = False
    mock_edge.strength = 1.0
    tm.connect_ports(mock_edge)

    tree = tm.build_spanning_tree()
    assert isinstance(tree, nx.DiGraph)
    assert tree.number_of_nodes() == 2

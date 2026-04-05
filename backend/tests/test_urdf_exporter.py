import os
import networkx as nx
import numpy as np
from xml.etree import ElementTree as ET
from backend.urdf_exporter import URDFExporter, export_urdf
from backend.connection_edge import ConnectionEdge

# mock objects to pass into URDFExporter

class MockPort:
    def derive_joint(self, other_port, is_merged):
        return "revolute", 0.5, 0.1

    def calculate_relative_transform(self, other_port, depth):
        # returns 4x4 matrix
        mat = np.eye(4)
        mat[:3, 3] = [0.1, 0.2, 0.3]
        return mat

class MockState:
    insertion_depth = 0.0

class MockPartData:
    def __init__(self, mass=0.001, inertia=np.eye(3)*1e-6, vis="vis.obj", col="col.obj"):
        self.mass = mass
        self.inertia = inertia
        self.visual_mesh = vis
        self.collision_mesh = col

def test_urdf_exporter(tmp_path):
    exporter = URDFExporter()
    tree = nx.DiGraph()

    # Add nodes
    tree.add_node("partA", data=MockPartData())
    tree.add_node("partB", data=MockPartData())

    # Add edge
    edge = ConnectionEdge(parent_id="partA", child_id="partB", port_parent=MockPort(), port_child=MockPort())
    edge.state = MockState()
    tree.add_edge("partA", "partB", data=edge)

    # closed loops
    loop_edge = ConnectionEdge(parent_id="partB", child_id="partA", port_parent=MockPort(), port_child=MockPort())
    loop_edge.state = MockState()
    closed_loops = [loop_edge]

    output_file = str(tmp_path / "test.urdf")

    exporter.export(tree, closed_loops, output_file, robot_name="test_robot")

    assert os.path.exists(output_file)
    tree_xml = ET.parse(output_file)
    root = tree_xml.getroot()

    assert root.tag == "robot"
    assert root.attrib["name"] == "test_robot"

    links = root.findall("link")
    assert len(links) == 2

    joints = root.findall("joint")
    assert len(joints) == 1
    assert joints[0].attrib["type"] == "revolute"

    gazebos = root.findall("gazebo")
    assert len(gazebos) == 1

def test_export_urdf_convenience(tmp_path):
    tree = nx.DiGraph()
    tree.add_node("partC", data=MockPartData())
    output_file = str(tmp_path / "test_convenience.urdf")

    export_urdf(tree, [], output_file, "convenience_robot")

    assert os.path.exists(output_file)
    tree_xml = ET.parse(output_file)
    assert tree_xml.getroot().attrib["name"] == "convenience_robot"

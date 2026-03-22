import sys
import os
import pytest
import numpy as np

# 确保加载 backend 模块
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.port_semantics import FitType
from backend.port import Port
from backend.connection_edge import ConnectionEdge
from backend.topology_manager import TopologyManager, PartNode

# ---------------------------------------------------------------------------
# 1. 装配生命周期测试 (v3.0 Topology-driven)
# ---------------------------------------------------------------------------

class TestAssemblyV3_0:
    def setup_method(self):
        self.tm = TopologyManager()

    def test_core_topology_flow(self):
        p1 = PartNode("p1", "long_pin")
        p2 = PartNode("p2", "beam")
        self.tm.add_part(p1)
        self.tm.add_part(p2)
        
        port1 = Port.from_raw("p", "pin.dat", [0, 0, 0], np.eye(3))
        port2 = Port.from_raw("h", "peghole.dat", [0, 0.008, 0], np.eye(3))
        edge = ConnectionEdge("p1", "p2", port1, port2)
        self.tm.connect_ports(edge)
        
        tree = self.tm.build_spanning_tree()
        assert tree.number_of_nodes() == 2
        assert tree.number_of_edges() == 1

if __name__ == '__main__':
    pytest.main([__file__])

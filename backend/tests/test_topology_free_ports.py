"""
test_topology_free_ports.py
============================
TopologyManager.get_occupied_port_keys 派生视图单测 (走法 A 期 A1)。
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.auto_latch_scanner import serialize_port_key  # noqa: E402
from backend.connection_edge import ConnectionEdge  # noqa: E402
from backend.port import Port  # noqa: E402
from backend.topology_manager import PartNode, TopologyManager  # noqa: E402


def _mk_port(name: str, ldraw_type: str, pos, rot=None) -> Port:
    if rot is None:
        rot = np.eye(3)
    port = Port.from_raw(
        name, ldraw_type, np.array(pos, dtype=float), np.array(rot, dtype=float),
        part_context="test",
    )
    if port is None:
        raise RuntimeError(f"无法创建测试 Port: {ldraw_type}")
    return port


def _mk_part(part_id: str) -> PartNode:
    return PartNode(part_id=part_id, name=part_id)


class TestGetOccupiedPortKeys(unittest.TestCase):
    """TopologyManager.get_occupied_port_keys"""

    def test_unknown_part_returns_empty_set(self):
        tm = TopologyManager()
        self.assertEqual(tm.get_occupied_port_keys("ghost"), set())

    def test_isolated_part_no_edges_returns_empty(self):
        tm = TopologyManager()
        tm.add_part(_mk_part("A"))
        self.assertEqual(tm.get_occupied_port_keys("A"), set())

    def test_part_as_parent_returns_port_parent_key(self):
        """A→B 边 (A 是 parent) → A 的占用 keys 含 port_parent 序列化。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("A"))
        tm.add_part(_mk_part("B"))
        port_a = _mk_port("ap", "peghole", [0, 0, 0])
        port_b = _mk_port("bp", "pin", [0, 0, 0])
        tm.connect_ports(ConnectionEdge("A", "B", port_a, port_b))
        keys = tm.get_occupied_port_keys("A")
        self.assertEqual(keys, {serialize_port_key(port_a.position, port_a.rotation)})

    def test_part_as_child_returns_port_child_key(self):
        """A→B 边 (B 是 child) → B 的占用 keys 含 port_child 序列化。"""
        tm = TopologyManager()
        tm.add_part(_mk_part("A"))
        tm.add_part(_mk_part("B"))
        port_a = _mk_port("ap", "peghole", [0, 0, 0])
        port_b = _mk_port("bp", "pin", [0.01, 0, 0])
        tm.connect_ports(ConnectionEdge("A", "B", port_a, port_b))
        keys = tm.get_occupied_port_keys("B")
        self.assertEqual(keys, {serialize_port_key(port_b.position, port_b.rotation)})

    def test_part_with_multiple_edges_aggregates_all_ports(self):
        """A 同时是 A→B 和 A→C 的 parent → A 占用 keys 含两条边的 port_parent。"""
        tm = TopologyManager()
        for pid in ("A", "B", "C"):
            tm.add_part(_mk_part(pid))
        # A 上两个不同位置的 ports
        port_a1 = _mk_port("a1", "peghole", [0, 0, 0])
        port_a2 = _mk_port("a2", "peghole", [0.04, 0, 0])
        port_b = _mk_port("bp", "pin", [0, 0, 0])
        port_c = _mk_port("cp", "pin", [0.04, 0, 0])
        tm.connect_ports(ConnectionEdge("A", "B", port_a1, port_b))
        tm.connect_ports(ConnectionEdge("A", "C", port_a2, port_c))
        keys = tm.get_occupied_port_keys("A")
        self.assertEqual(len(keys), 2)
        self.assertIn(serialize_port_key(port_a1.position, port_a1.rotation), keys)
        self.assertIn(serialize_port_key(port_a2.position, port_a2.rotation), keys)

    def test_part_as_both_parent_and_child(self):
        """B 既是 A→B 的 child 又是 B→C 的 parent → 两个不同 port keys 都进集合。"""
        tm = TopologyManager()
        for pid in ("A", "B", "C"):
            tm.add_part(_mk_part(pid))
        port_b_as_child = _mk_port("bp1", "pin", [0, 0, 0])
        port_b_as_parent = _mk_port("bp2", "peghole", [0.04, 0, 0])
        tm.connect_ports(ConnectionEdge(
            "A", "B", _mk_port("ap", "peghole", [0, 0, 0]), port_b_as_child,
        ))
        tm.connect_ports(ConnectionEdge(
            "B", "C", port_b_as_parent, _mk_port("cp", "pin", [0, 0, 0]),
        ))
        keys = tm.get_occupied_port_keys("B")
        self.assertEqual(len(keys), 2)
        self.assertIn(serialize_port_key(port_b_as_child.position, port_b_as_child.rotation), keys)
        self.assertIn(serialize_port_key(port_b_as_parent.position, port_b_as_parent.rotation), keys)

    def test_dual_face_connhole_each_face_has_distinct_key(self):
        """同位置不同法线（连孔双面）→ 两个 port 序列化产生不同 key,
        各自独立占用，不会因为 position 相同而误合并。"""
        tm = TopologyManager()
        for pid in ("A", "B", "C"):
            tm.add_part(_mk_part(pid))
        # A 上同位置正反两面
        front = _mk_port("front", "peghole", [0, 0, 0])  # rot=identity, z 法线 +1
        back = _mk_port(
            "back", "peghole", [0, 0, 0],
            rot=np.array([[1, 0, 0], [0, 1, 0], [0, 0, -1]]),  # z 法线 -1
        )
        tm.connect_ports(ConnectionEdge("A", "B", front, _mk_port("bp", "pin", [0, 0, 0])))
        # back 还没插 → 只 front 进 occupied
        keys = tm.get_occupied_port_keys("A")
        self.assertEqual(len(keys), 1)
        self.assertIn(serialize_port_key(front.position, front.rotation), keys)
        self.assertNotIn(serialize_port_key(back.position, back.rotation), keys)
        # 再插 back
        tm.connect_ports(ConnectionEdge("A", "C", back, _mk_port("cp", "pin", [0, 0, 0])))
        keys = tm.get_occupied_port_keys("A")
        self.assertEqual(len(keys), 2)


if __name__ == "__main__":
    unittest.main()

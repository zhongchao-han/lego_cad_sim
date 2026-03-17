"""
tests/test_assembly_root.py
============================
Assembly ROOT 管理、zone 过滤、自动闭环扫描的单元测试。

涵盖场景：
  1. PartZone 枚举与 Part.zone 默认值
  2. Assembly.set_root() / migrate_root()
  3. resolve_kinematics 使用显式 root_part_id
  4. resolve_kinematics 过滤 WORKBENCH 零件
  5. scan_and_seal_loops 自动闭环
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest

from part import Part, PartZone
from port import Port
from connection_edge import ConnectionEdge
from assembly import Assembly


# ---------------------------------------------------------------------------
# 辅助构造器
# ---------------------------------------------------------------------------

def make_hole(name="h", pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback(name, "peghole.dat", np.array(pos, dtype=float), np.eye(3))


def make_pin(name="p", pos=(0.0, 0.0, 0.0)) -> Port:
    return Port.from_ldraw_or_fallback(name, "pin.dat", np.array(pos, dtype=float), np.eye(3))


def make_beam(part_id: str, *, hole_positions=None) -> Part:
    beam = Part(part_id, f"beam_{part_id}")
    if hole_positions is None:
        hole_positions = [(0.0, 0.0, 0.0)]
    for i, pos in enumerate(hole_positions):
        beam.add_port(make_hole(f"h{i}", pos=pos))
    return beam


def make_pin_part(part_id: str) -> Part:
    pin = Part(part_id, f"pin_{part_id}")
    pin.add_port(make_pin("p0", pos=(0.0, 0.0, 0.0)))
    pin.add_port(make_pin("p1", pos=(0.0, 0.016, 0.0)))
    return pin


def connect(asm: Assembly, parent_id: str, child_id: str,
            parent_port="h0", child_port="h0") -> None:
    p_port = asm.parts[parent_id].get_port(parent_port) or make_pin()
    c_port = asm.parts[child_id].get_port(child_port) or make_hole()
    edge = ConnectionEdge(parent_id, child_id, p_port, c_port)
    asm.connect_ports(edge)


# ---------------------------------------------------------------------------
# 1. PartZone
# ---------------------------------------------------------------------------

class TestPartZone:

    def test_default_zone_is_active_arena(self):
        part = Part("A", "beam")
        assert part.zone == PartZone.ACTIVE_ARENA

    def test_zone_can_be_set_to_workbench(self):
        part = Part("A", "beam")
        part.zone = PartZone.WORKBENCH
        assert part.zone == PartZone.WORKBENCH

    def test_zone_can_be_set_to_preview(self):
        part = Part("A", "beam")
        part.zone = PartZone.PREVIEW
        assert part.zone == PartZone.PREVIEW

    def test_repr_includes_zone(self):
        part = Part("A", "beam")
        r = repr(part)
        assert "ACTIVE_ARENA" in r

    def test_repr_shows_workbench_zone(self):
        part = Part("A", "beam")
        part.zone = PartZone.WORKBENCH
        assert "WORKBENCH" in repr(part)


# ---------------------------------------------------------------------------
# 2. Assembly.set_root / migrate_root
# ---------------------------------------------------------------------------

class TestRootManagement:

    def setup_method(self):
        self.asm = Assembly("test_asm")
        self.asm.add_part(Part("A", "beam_A"))
        self.asm.add_part(Part("B", "beam_B"))

    def test_root_is_none_by_default(self):
        assert self.asm.root_part_id is None

    def test_set_root_updates_root_part_id(self):
        self.asm.set_root("A")
        assert self.asm.root_part_id == "A"

    def test_set_root_to_different_part(self):
        self.asm.set_root("A")
        self.asm.set_root("B")
        assert self.asm.root_part_id == "B"

    def test_set_root_unknown_part_raises(self):
        with pytest.raises(ValueError, match="GHOST"):
            self.asm.set_root("GHOST")

    def test_migrate_root_same_semantics_as_set_root(self):
        self.asm.migrate_root("B")
        assert self.asm.root_part_id == "B"

    def test_migrate_root_unknown_raises(self):
        with pytest.raises(ValueError):
            self.asm.migrate_root("UNKNOWN")


# ---------------------------------------------------------------------------
# 3. resolve_kinematics 使用显式 root_part_id
# ---------------------------------------------------------------------------

class TestResolvKinematicsWithExplicitRoot:

    def setup_method(self):
        # A → B → C 链式连接
        self.asm = Assembly("chain_asm")
        for pid in ("A", "B", "C"):
            p = Part(pid, f"beam_{pid}")
            p.add_port(make_pin(f"pin_{pid}"))
            p.add_port(make_hole(f"hole_{pid}"))
            self.asm.add_part(p)

        self.asm.connect_ports(ConnectionEdge(
            "A", "B",
            make_pin("pA"), make_hole("hB"),
        ))
        self.asm.connect_ports(ConnectionEdge(
            "B", "C",
            make_pin("pB"), make_hole("hC"),
        ))

    def test_without_root_uses_indegree_zero(self):
        tree = self.asm.resolve_kinematics()
        assert tree.number_of_nodes() == 3
        assert tree.number_of_edges() == 2

    def test_with_explicit_root_same_topology(self):
        self.asm.set_root("A")
        tree = self.asm.resolve_kinematics()
        assert tree.number_of_nodes() == 3
        assert tree.number_of_edges() == 2

    def test_root_is_first_in_bfs_order(self):
        """显式 root 应出现在树中且入度为 0。"""
        self.asm.set_root("A")
        tree = self.asm.resolve_kinematics()
        assert tree.in_degree("A") == 0

    def test_explicit_root_can_be_non_indegree_zero(self):
        """
        BFS 是有向遍历（只走 successors）。
        在 A→B→C 图中设 root=B 时，BFS 沿有向边到达 C；
        A 在 B 的上游不可达。root=B 的实际意义：B 的子树被导出。
        """
        self.asm.set_root("B")
        tree = self.asm.resolve_kinematics()
        assert "B" in tree.nodes
        assert "C" in tree.nodes
        # A 在 B 的上游，有向 BFS 不可达
        assert tree.number_of_nodes() == 2

    def test_root_migration_after_snap_updates_kinematics_root(self):
        """simulate_snap 后迁移 ROOT，resolve_kinematics 应使用新 ROOT。"""
        self.asm.set_root("A")
        self.asm.migrate_root("C")
        assert self.asm.root_part_id == "C"
        tree = self.asm.resolve_kinematics()
        assert "C" in tree.nodes


# ---------------------------------------------------------------------------
# 4. resolve_kinematics 过滤 WORKBENCH 零件
# ---------------------------------------------------------------------------

class TestResolveKinematicsWorkbenchFilter:

    def setup_method(self):
        self.asm = Assembly("zone_asm")
        for pid in ("A", "B", "W"):
            self.asm.add_part(Part(pid, f"beam_{pid}"))

        self.asm.connect_ports(ConnectionEdge(
            "A", "B",
            make_pin("pA"), make_hole("hB"),
        ))
        # W 连到 A，但 W 将被设为 WORKBENCH
        self.asm.connect_ports(ConnectionEdge(
            "A", "W",
            make_pin("pAW"), make_hole("hW"),
        ))

    def test_workbench_part_excluded_from_tree(self):
        self.asm.parts["W"].zone = PartZone.WORKBENCH
        tree = self.asm.resolve_kinematics()
        assert "W" not in tree.nodes
        assert "A" in tree.nodes
        assert "B" in tree.nodes

    def test_active_parts_still_included(self):
        self.asm.parts["W"].zone = PartZone.WORKBENCH
        tree = self.asm.resolve_kinematics()
        assert tree.number_of_nodes() == 2  # A and B only

    def test_all_active_no_filtering(self):
        """所有零件均为 ACTIVE_ARENA 时，无任何过滤。"""
        tree = self.asm.resolve_kinematics()
        assert tree.number_of_nodes() == 3

    def test_preview_part_also_excluded(self):
        self.asm.parts["W"].zone = PartZone.PREVIEW
        tree = self.asm.resolve_kinematics()
        assert "W" not in tree.nodes


# ---------------------------------------------------------------------------
# 5. scan_and_seal_loops
# ---------------------------------------------------------------------------

class TestScanAndSealLoops:

    def _build_two_pin_assembly(self):
        """
        构建：插销 PIN 从一侧插入梁 A，另一侧（p1）距梁 B 的 h0 非常近（< 1mm）。
        """
        asm = Assembly("seal_asm")

        # 插销：两端端口
        pin = Part("PIN", "pin")
        pin.add_port(make_pin("p0", pos=(0.0, 0.0, 0.0)))
        pin.add_port(make_pin("p1", pos=(0.0, 0.016, 0.0)))
        asm.add_part(pin)

        # 梁 A：p0 已连接
        beam_a = Part("A", "beam_A")
        beam_a.add_port(make_hole("h0", pos=(0.0, 0.0, 0.0)))
        asm.add_part(beam_a)

        # 梁 B：h0 靠近 PIN.p1（全局位置相差 0.0005m，在默认阈值 0.001m 内，
        #        但超出严格阈值 0.0001m）
        beam_b = Part("B", "beam_B")
        beam_b.add_port(make_hole("h0", pos=(0.0, 0.0165, 0.0)))
        asm.add_part(beam_b)

        # 已建立：PIN.p0 → A.h0
        asm.connect_ports(ConnectionEdge(
            "PIN", "A",
            pin.get_port("p0"),
            beam_a.get_port("h0"),
        ))

        return asm

    def test_scan_finds_nearby_compatible_port(self):
        asm = self._build_two_pin_assembly()
        new_edges = asm.scan_and_seal_loops(moved_part_ids=["PIN"], distance_threshold_m=0.002)
        assert len(new_edges) == 1

    def test_scan_creates_valid_connection_edge(self):
        asm = self._build_two_pin_assembly()
        new_edges = asm.scan_and_seal_loops(moved_part_ids=["PIN"])
        assert len(new_edges) == 1
        edge = new_edges[0]
        assert "PIN" in (edge.parent_id, edge.child_id)
        assert "B" in (edge.parent_id, edge.child_id)

    def test_scan_edge_added_to_assembly_connections(self):
        asm = self._build_two_pin_assembly()
        before = len(asm.connections)
        asm.scan_and_seal_loops(moved_part_ids=["PIN"])
        assert len(asm.connections) == before + 1

    def test_scan_below_threshold_finds_nothing(self):
        asm = self._build_two_pin_assembly()
        # threshold 太小，找不到
        new_edges = asm.scan_and_seal_loops(moved_part_ids=["PIN"], distance_threshold_m=0.0001)
        assert len(new_edges) == 0

    def test_scan_does_not_duplicate_existing_connections(self):
        """已连接端口不应再次被扫描匹配。"""
        asm = self._build_two_pin_assembly()
        asm.scan_and_seal_loops(moved_part_ids=["PIN"])
        before = len(asm.connections)
        # 再次扫描，不应重复添加
        asm.scan_and_seal_loops(moved_part_ids=["PIN"])
        assert len(asm.connections) == before

    def test_scan_skips_workbench_parts(self):
        asm = self._build_two_pin_assembly()
        asm.parts["B"].zone = PartZone.WORKBENCH
        new_edges = asm.scan_and_seal_loops(moved_part_ids=["PIN"])
        assert len(new_edges) == 0

    def test_scan_empty_moved_ids_returns_empty(self):
        asm = self._build_two_pin_assembly()
        new_edges = asm.scan_and_seal_loops(moved_part_ids=[])
        assert len(new_edges) == 0


# ---------------------------------------------------------------------------
# 命令行直接运行
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import subprocess
    result = subprocess.run(
        ["python", "-m", "pytest", __file__, "-v"],
        cwd=os.path.join(os.path.dirname(__file__), ".."),
    )
    sys.exit(result.returncode)

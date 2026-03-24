"""
test_v3_0_site_utils.py
========================
unit tests for site_utils.cluster_ports_into_sites.
covers: empty input, single port, multiple isolated sites,
concurrent sites (shared position), and unknown port type fallback.
"""

import numpy as np
import pytest

from backend.site_utils import cluster_ports_into_sites, SITE_MERGE_THRESHOLD


# ─── helpers ──────────────────────────────────────────────────────────────────

def _make_port(name: str, ptype: str, pos: list) -> dict:
    return {
        "name": name,
        "type": ptype,
        "position": pos,
        "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    }


# ─── tests ────────────────────────────────────────────────────────────────────

def test_empty_ports():
    sites = cluster_ports_into_sites([], "test_part.dat")
    assert sites == []


def test_single_port_becomes_one_site():
    ports = [_make_port("p0", "peghole", [0.0, 0.0, 0.0])]
    sites = cluster_ports_into_sites(ports, "3706.dat")
    assert len(sites) == 1
    assert len(sites[0].ports) == 1
    assert sites[0].id == "3706.dat_site0"


def test_two_distinct_positions_become_two_sites():
    """端口间距 >> 阈值，应产生两个独立 Site。"""
    ports = [
        _make_port("p0", "peghole", [0.0, 0.0, 0.0]),
        _make_port("p1", "peghole", [0.008, 0.0, 0.0]),  # 8mm 间距
    ]
    sites = cluster_ports_into_sites(ports, "32316.dat")
    assert len(sites) == 2
    for site in sites:
        assert len(site.ports) == 1


def test_concentric_ports_merge_into_one_site():
    """同心孔（圆+十字），距离 < SITE_MERGE_THRESHOLD，应合并为同一 Site。"""
    offset = SITE_MERGE_THRESHOLD * 0.1  # 远小于阈值
    ports = [
        _make_port("p_round", "peghole", [0.0, 0.0, 0.0]),
        _make_port("p_cross", "axlehole", [offset, 0.0, 0.0]),
    ]
    sites = cluster_ports_into_sites(ports, "32015.dat")
    assert len(sites) == 1
    assert len(sites[0].ports) == 2


def test_border_distance_exactly_at_threshold_not_merged():
    """恰好等于阈值的两端口不应合并（严格小于）。"""
    pos = [SITE_MERGE_THRESHOLD, 0.0, 0.0]
    ports = [
        _make_port("p0", "peghole", [0.0, 0.0, 0.0]),
        _make_port("p1", "peghole", pos),
    ]
    sites = cluster_ports_into_sites(ports, "test.dat")
    # SITE_MERGE_THRESHOLD == distance => not merged
    assert len(sites) == 2


def test_unknown_port_type_is_skipped():
    """无法识别的端口类型跳过，不归入任何 Site。"""
    ports = [
        _make_port("p0", "peghole", [0.0, 0.0, 0.0]),
        _make_port("p_unknown", "totally_unknown_primitive.dat", [0.0, 0.0, 0.0]),
    ]
    sites = cluster_ports_into_sites(ports, "test.dat")
    # p_unknown 被丢弃，只有 peghole 产生 site
    assert len(sites) == 1
    assert len(sites[0].ports) == 1
    assert sites[0].ports[0].name == "p0"


def test_site_position_reflects_first_port():
    """Site.position 应等于其首个端口的坐标。"""
    ports = [_make_port("p0", "peghole", [0.004, 0.0, 0.0])]
    sites = cluster_ports_into_sites(ports, "test.dat")
    np.testing.assert_allclose(sites[0].position, [0.004, 0.0, 0.0])


def test_site_is_not_occupied_by_default():
    """新创建的 Site 默认未被占用。"""
    ports = [_make_port("p0", "peghole", [0.0, 0.0, 0.0])]
    sites = cluster_ports_into_sites(ports, "test.dat")
    assert not sites[0].is_occupied()

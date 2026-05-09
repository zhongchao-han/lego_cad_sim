"""
test_plug_clustering.py
========================
plug-level 启发式聚类单测 (走法 A 期 A2)。

覆盖：
  - 3 个 baseline (用户共识)：
      170.dat (2x4 plate)  → 2 plug (top_studs / bottom_tubes)
      2780.dat (销)        → 2 plug (±x_pin_end)
      40490.dat (9-hole 梁) → 1 plug (贯通孔合并)
  - 边界 case：
      纯 stud 1x1 板 (3024.dat)
      斜面零件 / 角连接器
      装饰类零件 (无 port → 0 plug)
      Female 单面孔不合并
      MALE 反向法线必不合
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.plug_clustering import (  # noqa: E402
    GENDER_FEMALE,
    GENDER_MALE,
    PROFILE_CYL,
    PROFILE_STUD,
    Plug,
    compute_plugs,
)
from backend.port_library import PortLibrary  # noqa: E402


# ─── 工具：构造合成 sites（不依赖 ldraw_port_configs.json） ────────────────────


def _site(site_id: str, position, ports):
    return {"id": site_id, "position": list(position), "ports": ports}


def _port(ptype: str, position, normal=(0, 1, 0)):
    """合成 port 字典。rotation 第三列 = normal。"""
    nx, ny, nz = normal
    if abs(ny) > 0.9:
        rotation = [[1, 0, nx], [0, 1, ny], [0, 0, nz]]
    elif abs(nx) > 0.9:
        rotation = [[0, 0, nx], [0, 1, ny], [1, 0, nz]]
    else:
        rotation = [[1, 0, nx], [0, 0, ny], [0, 1, nz]]
    return {"type": ptype, "position": list(position), "rotation": rotation}


# ─── Baseline tests（基于真实 ldraw_port_configs.json 数据） ──────────────────


class TestBaselines(unittest.TestCase):
    """三个用户拍板的 baseline 案例 — 跑真实库数据。"""

    lib: PortLibrary

    @classmethod
    def setUpClass(cls):
        cls.lib = PortLibrary()

    def _sites_for(self, part_id: str):
        return self.lib._data.get(part_id, {}).get("sites", [])

    def test_170_2x4_plate_two_plugs(self):
        """170.dat: 2x4 plate — 顶 + 底 → 严格分 2 plug（face direction 反向）。"""
        sites = self._sites_for("170.dat")
        self.assertGreater(len(sites), 0, "170.dat 缺数据")
        plugs = compute_plugs(sites, "170.dat")
        self.assertEqual(len(plugs), 2)
        # 顶/底必反向：dot(dir_a, dir_b) ≈ -1
        d0, d1 = plugs[0].direction, plugs[1].direction
        dot = d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2]
        self.assertLess(dot, -0.95)
        # 二者 face label 应分别含 top/bottom（或对称的 ±x/±z 面）
        labels = {p.label for p in plugs}
        # 至少其中一个 label 含 face 关键词
        self.assertTrue(
            any("top" in lbl or "bottom" in lbl or "+" in lbl or "-" in lbl
                for lbl in labels),
            f"labels={labels}",
        )

    def test_2780_pin_two_plugs(self):
        """2780.dat: 销 — 头/尾分开成 2 plug（MALE 不合反向）。"""
        sites = self._sites_for("2780.dat")
        self.assertGreater(len(sites), 0, "2780.dat 缺数据")
        plugs = compute_plugs(sites, "2780.dat")
        self.assertEqual(len(plugs), 2)
        for p in plugs:
            self.assertEqual(p.gender, GENDER_MALE)
            self.assertEqual(p.profile, PROFILE_CYL)
            self.assertEqual(p.port_count, 1)

    def test_40490_9_hole_beam_one_plug(self):
        """40490.dat: 9-hole 梁 — 贯通孔双面合 → 1 plug（FEMALE 反向法线合并）。"""
        sites = self._sites_for("40490.dat")
        self.assertGreater(len(sites), 0, "40490.dat 缺数据")
        plugs = compute_plugs(sites, "40490.dat")
        self.assertEqual(len(plugs), 1)
        self.assertEqual(plugs[0].gender, GENDER_FEMALE)


# ─── Synthetic edge case tests（控制变量、不依赖真实数据） ──────────────────


class TestEmptyAndDecorative(unittest.TestCase):
    """无 port 的装饰零件 → 0 plug。"""

    def test_no_sites(self):
        self.assertEqual(compute_plugs([], "decorative.dat"), [])

    def test_sites_no_ports(self):
        sites = [_site("s0", (0, 0, 0), [])]
        self.assertEqual(compute_plugs(sites, "blank.dat"), [])

    def test_unknown_port_type_skipped(self):
        sites = [_site("s0", (0, 0, 0), [_port("unknownXYZ", (0, 0, 0))])]
        self.assertEqual(compute_plugs(sites, "weird.dat"), [])


class TestSingleStudPlug(unittest.TestCase):
    """单 stud → 1 plug。"""

    def test_one_stud(self):
        sites = [_site("s0", (0, 0, 0), [_port("stud", (0, 0.004, 0), normal=(0, 1, 0))])]
        plugs = compute_plugs(sites, "1x1.dat")
        self.assertEqual(len(plugs), 1)
        self.assertEqual(plugs[0].gender, GENDER_MALE)
        self.assertEqual(plugs[0].profile, PROFILE_STUD)
        self.assertEqual(plugs[0].port_count, 1)


class TestFemaleDualFaceMerge(unittest.TestCase):
    """FEMALE 反向法线 + 法线平面位置重合 → 合并贯通孔。"""

    def test_dual_face_merges(self):
        # 同 X/Z 位置，Y=±0.004 (4mm 板厚)，反向法线
        sites = [
            _site("s0", (0, 0.004, 0), [_port("peghole", (0, 0.004, 0), normal=(0, 1, 0))]),
            _site("s1", (0, -0.004, 0), [_port("peghole", (0, -0.004, 0), normal=(0, -1, 0))]),
        ]
        plugs = compute_plugs(sites, "beamhole.dat")
        # 双面合并 → 1 plug
        self.assertEqual(len(plugs), 1)
        self.assertEqual(plugs[0].port_count, 2)

    def test_single_face_does_not_merge(self):
        # 仅顶面 — 没合并对象
        sites = [
            _site("s0", (0, 0.004, 0), [_port("peghole", (0, 0.004, 0), normal=(0, 1, 0))]),
        ]
        plugs = compute_plugs(sites, "blindhole.dat")
        self.assertEqual(len(plugs), 1)
        self.assertEqual(plugs[0].port_count, 1)


class TestMaleNoMerge(unittest.TestCase):
    """MALE 反向法线必不合 — 销两端独立。"""

    def test_pin_ends_split(self):
        # 同 X/Z 位置反向法线 — MALE 不合
        sites = [
            _site("s0", (0.0, 0.0, 0.0), [
                _port("peg", (0.005, 0, 0), normal=(1, 0, 0)),
                _port("peg", (-0.005, 0, 0), normal=(-1, 0, 0)),
            ]),
        ]
        plugs = compute_plugs(sites, "2780_synth.dat")
        self.assertEqual(len(plugs), 2)
        for p in plugs:
            self.assertEqual(p.gender, GENDER_MALE)


class TestGeometricSplit(unittest.TestCase):
    """动态 max-gap split — 同方向但有 outlier 时切开。"""

    def test_isolated_stud_splits(self):
        # 4 个连续 stud (间距 0.008m) + 1 个远端 stud (差 0.05m)
        ports = []
        for i in range(4):
            ports.append(_port("stud", (i * 0.008, 0.004, 0), normal=(0, 1, 0)))
        ports.append(_port("stud", (1.0, 0.004, 0), normal=(0, 1, 0)))
        sites = [_site("s0", (0, 0, 0), ports)]
        plugs = compute_plugs(sites, "synth_split.dat")
        # 一个连续簇 + 一个孤立点 → 2 plug
        self.assertEqual(len(plugs), 2)

    def test_uniform_grid_no_split(self):
        # 8 stud 均匀网格（2x4 plate top）— median ≈ max → 不切
        ports = []
        for x in range(2):
            for z in range(4):
                ports.append(_port(
                    "stud",
                    (x * 0.008, 0.004, z * 0.008),
                    normal=(0, 1, 0),
                ))
        sites = [_site("s0", (0, 0, 0), ports)]
        plugs = compute_plugs(sites, "synth_grid.dat")
        self.assertEqual(len(plugs), 1)
        self.assertEqual(plugs[0].port_count, 8)


class TestPlugSerialization(unittest.TestCase):
    """Plug.to_dict 反向索引完整性 — 落盘格式契约。"""

    def test_to_dict_has_all_fields(self):
        sites = [_site("s0", (0, 0, 0), [_port("stud", (0, 0.004, 0), normal=(0, 1, 0))])]
        plugs = compute_plugs(sites, "x.dat")
        d = plugs[0].to_dict()
        for k in ("plug_id", "label", "gender", "profile", "direction",
                  "members", "port_count", "site_ids"):
            self.assertIn(k, d)
        self.assertEqual(d["members"], [["s0", 0]])
        self.assertEqual(d["site_ids"], ["s0"])
        self.assertEqual(d["port_count"], 1)


class TestPortLibraryParsePlugs(unittest.TestCase):
    """PortLibrary.parse_plugs 加载路径：baked JSON 优先 + 老数据 fallback。"""

    lib: PortLibrary

    @classmethod
    def setUpClass(cls):
        cls.lib = PortLibrary()

    def test_baked_plugs_returned(self):
        plugs = self.lib.parse_plugs("170.dat")
        self.assertEqual(len(plugs), 2)
        self.assertTrue(all(isinstance(p, Plug) for p in plugs))

    def test_unknown_part_returns_empty(self):
        self.assertEqual(self.lib.parse_plugs("nonexistent_part.dat"), [])

    def test_fallback_runtime_compute(self):
        """模拟老数据：临时去掉 plug_version，验证现算路径。"""
        original = self.lib._data.get("170.dat")
        if original is None:
            self.skipTest("170.dat 不在数据库")
        # 浅拷贝 + 去 plug 字段
        stripped = {k: v for k, v in original.items() if k not in ("plug_version", "plugs")}
        self.lib._data["170.dat"] = stripped
        try:
            plugs = self.lib.parse_plugs("170.dat")
            self.assertEqual(len(plugs), 2)
        finally:
            self.lib._data["170.dat"] = original


if __name__ == "__main__":
    unittest.main()

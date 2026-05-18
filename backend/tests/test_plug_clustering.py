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
        """170.dat: Technic Gearbox — 顶/底两组 stud，face label 按 centroid 排名。

        Bug 2 锁定：之前 direction-only 标签把 cy=-0.0208 的下侧 plug 叫成
        'top_studs'、cy=0 的上侧 plug 叫成 'bottom_studs'，跟视觉相反。
        新 cross-plug 排名后：cy 较小 → 'bottom'，cy 较大 → 'top'。
        """
        sites = self._sites_for("170.dat")
        self.assertGreater(len(sites), 0, "170.dat 缺数据")
        plugs = compute_plugs(sites, "170.dat")
        self.assertEqual(len(plugs), 2)
        # 顶/底必反向：dot(dir_a, dir_b) ≈ -1
        d0, d1 = plugs[0].direction, plugs[1].direction
        dot = d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2]
        self.assertLess(dot, -0.95)
        # Bug 2 修复：label 必须有一个 bottom_ 和一个 top_，且对应 centroid
        # cy 较小者 = bottom，较大者 = top
        by_cy = []
        for p in plugs:
            cy = sum(
                next(s for s in sites if s["id"] == sid)["ports"][pidx]["position"][1]
                for sid, pidx in p.members
            ) / len(p.members)
            by_cy.append((cy, p.label))
        by_cy.sort()
        self.assertTrue(by_cy[0][1].startswith("bottom_"),
                        f"smallest cy {by_cy[0][0]:+.4f} should be bottom_*, got {by_cy[0][1]}")
        self.assertTrue(by_cy[-1][1].startswith("top_"),
                        f"largest cy {by_cy[-1][0]:+.4f} should be top_*, got {by_cy[-1][1]}")

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


class TestFaceLabelRanking(unittest.TestCase):
    """Bug 2 修复 — face label 由 cross-plug centroid 排名拍板，不再 direction-only。"""

    def test_two_y_plugs_ranked_by_centroid(self):
        """Y 轴上 2 个 plug → cy 较小者 = bottom，较大者 = top（即使 direction 颠倒）。"""
        # plug A: cy=-0.0208, direction +Y（旧 heuristic 错叫 top）
        # plug B: cy=0,       direction -Y（旧 heuristic 错叫 bottom）
        # 新 heuristic：按 centroid 排，A 在下 → bottom_studs；B 在上 → top_studs
        sites = [
            _site("sA", (0, -0.0208, 0), [
                _port("stud4", (0, -0.0208, 0.0), normal=(0, 1, 0)),
                _port("stud4", (0, -0.0208, 0.008), normal=(0, 1, 0)),
            ]),
            _site("sB", (0, 0, 0), [
                _port("stud2", (0.004, 0, -0.004), normal=(0, -1, 0)),
                _port("stud2", (0.004, 0, 0.004), normal=(0, -1, 0)),
                _port("stud2", (-0.004, 0, -0.004), normal=(0, -1, 0)),
                _port("stud2", (-0.004, 0, 0.004), normal=(0, -1, 0)),
            ]),
        ]
        plugs = compute_plugs(sites, "synth_170.dat")
        self.assertEqual(len(plugs), 2)
        # 按 centroid_y 排序后断言
        def cy_of(plug):
            return sum(
                next(s for s in sites if s["id"] == sid)["ports"][pidx]["position"][1]
                for sid, pidx in plug.members
            ) / len(plug.members)
        sorted_by_cy = sorted(plugs, key=cy_of)
        self.assertTrue(sorted_by_cy[0].label.startswith("bottom_"),
                        f"lower plug should be bottom_*, got {sorted_by_cy[0].label}")
        self.assertTrue(sorted_by_cy[-1].label.startswith("top_"),
                        f"upper plug should be top_*, got {sorted_by_cy[-1].label}")

    def test_single_y_plug_uses_centroid_sign(self):
        """单 Y 轴 plug 偏离原点 → 按 centroid 符号；卡原点 → 按 direction 兜底。"""
        # cy > 0 → 'top'
        sites_top = [_site("s0", (0, 0.004, 0), [
            _port("stud", (0, 0.004, 0), normal=(0, 1, 0)),
        ])]
        plugs = compute_plugs(sites_top, "single_top.dat")
        self.assertEqual(plugs[0].label, "top_studs")

        # cy < 0 → 'bottom'
        sites_bot = [_site("s0", (0, -0.004, 0), [
            _port("stud", (0, -0.004, 0), normal=(0, 1, 0)),
        ])]
        plugs = compute_plugs(sites_bot, "single_bot.dat")
        self.assertEqual(plugs[0].label, "bottom_studs")

        # cy ≈ 0 + dir +Y → 'top'（direction 兜底）
        sites_origin = [_site("s0", (0, 0, 0), [
            _port("stud", (0, 0, 0), normal=(0, 1, 0)),
        ])]
        plugs = compute_plugs(sites_origin, "single_origin.dat")
        self.assertEqual(plugs[0].label, "top_studs")

    def test_pin_centroids_degenerate_falls_back_to_direction(self):
        """销两端 centroid 都在原点（spread<eps）→ 按 direction 兜底，得 -x/+x。"""
        sites = [_site("s0", (0, 0, 0), [
            _port("confric5", (0, 0, 0), normal=(1, 0, 0)),
            _port("confric5", (0, 0, 0), normal=(-1, 0, 0)),
        ])]
        plugs = compute_plugs(sites, "synth_2780.dat")
        self.assertEqual(len(plugs), 2)
        labels = sorted(p.label for p in plugs)
        self.assertEqual(labels, ["+x_pin_end", "-x_pin_end"])

    def test_three_y_plugs_middle_gets_mid_label(self):
        """3+ 个 Y 轴 plug → 极端 top/bottom，中间 mid_y<rank> 区分（防重名）。"""
        sites = [
            _site("sBot", (0, -0.02, 0), [_port("stud", (0, -0.02, 0), normal=(0, 1, 0))]),
            _site("sMid", (0, 0, 0),     [_port("stud", (0, 0, 0),     normal=(0, 1, 0))]),
            _site("sTop", (0, 0.02, 0),  [_port("stud", (0, 0.02, 0),  normal=(0, 1, 0))]),
        ]
        plugs = compute_plugs(sites, "synth_three_levels.dat")
        # 因 max-gap split：3 个均匀 stud 可能合一或分三；这里距 0.02 远超 stud
        # 直径，每对间 gap 相同 → median == max → 不切。所以会合并为 1 plug。
        # 用更紧凑的位置 + outlier 触发 split：
        sites = [
            _site("s0", (0, 0, 0), [
                _port("stud", (0, -0.04, 0), normal=(0, 1, 0)),  # 远下
                _port("stud", (0, 0, 0),     normal=(0, 1, 0)),  # 中
                _port("stud", (0, 0.04, 0),  normal=(0, 1, 0)),  # 远上
            ]),
        ]
        plugs = compute_plugs(sites, "synth_three_levels_v2.dat")
        # 这里 3 个 stud 均匀分布也合并 — gap 相等 → 1 plug，不触发 3 plug 路径
        # 验证 _assign_face_labels 的 mid 路径需要直接调函数测：
        from backend.plug_clustering import (
            _assign_face_labels, _FlatPort,
            GENDER_MALE, PROFILE_STUD,
        )
        fp_bot = _FlatPort("s0", 0, "stud", (0, -0.02, 0), (0, 1, 0), GENDER_MALE, PROFILE_STUD)
        fp_mid = _FlatPort("s0", 1, "stud", (0, 0, 0),     (0, 1, 0), GENDER_MALE, PROFILE_STUD)
        fp_top = _FlatPort("s0", 2, "stud", (0, 0.02, 0),  (0, 1, 0), GENDER_MALE, PROFILE_STUD)
        meta = [
            ([fp_bot], GENDER_MALE, PROFILE_STUD, (0, 1, 0)),
            ([fp_mid], GENDER_MALE, PROFILE_STUD, (0, 1, 0)),
            ([fp_top], GENDER_MALE, PROFILE_STUD, (0, 1, 0)),
        ]
        faces = _assign_face_labels(meta)
        self.assertEqual(faces[0], "bottom")
        self.assertEqual(faces[1], "mid_y1")
        self.assertEqual(faces[2], "top")

    def test_x_axis_plugs_use_plus_minus_x(self):
        """X 轴 plug 用 ±x 命名（不是 top/bottom）— 保持向后兼容。"""
        sites = [_site("s0", (0, 0, 0), [
            _port("confric5", (-0.005, 0, 0), normal=(-1, 0, 0)),
            _port("confric5", (0.005, 0, 0),  normal=(1, 0, 0)),
        ])]
        plugs = compute_plugs(sites, "synth_x_pin.dat")
        labels = sorted(p.label for p in plugs)
        # 注意：销两端 port 共 site，centroid 各自单 port，cx 分离 0.01 → rank 命名
        self.assertEqual(labels, ["+x_pin_end", "-x_pin_end"])


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

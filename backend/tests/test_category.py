"""
test_category.py
=================
覆盖 backend/category.py 的两层契约：
  - categorize() 关键词 → 桶映射的优先级正确性（Axle Pin → Pin，不应进 Axle）
  - get_part_name() 在文件不存在 / 解析失败时优雅退化
  - categorize_part() 一站式 (name, category) 返回
"""
from __future__ import annotations

import os
import sys
import unittest
from tempfile import TemporaryDirectory

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.category import (  # noqa: E402
    CATEGORY_ORDER,
    categorize,
    categorize_part,
    get_part_name,
)


class TestCategorize(unittest.TestCase):
    def test_empty_or_none_falls_to_other(self):
        self.assertEqual(categorize(""), "Other")
        self.assertEqual(categorize(None), "Other")  # type: ignore[arg-type]

    def test_strips_unofficial_marker(self):
        # ~ 和 = 是 LDraw unofficial / placeholder 标记，必须先剥离
        self.assertEqual(categorize("~Technic Pin Long Friction"), "Pin")
        self.assertEqual(categorize("=Technic Chain Tread 2.5 Wide"), "Other")

    def test_axle_pin_prioritizes_pin_over_axle(self):
        # 优先级关键 case：Axle Pin 是连接销，应进 Pin 桶
        self.assertEqual(categorize("Technic Axle Pin Long with Friction"), "Pin")
        # 单纯 Axle 仍走 Axle
        self.assertEqual(categorize("Technic Axle  4L"), "Axle")

    def test_connector_takes_precedence_over_pin(self):
        # "Pin Connector" 是 Connector 类，比单 Pin 更高
        self.assertEqual(categorize("Technic Axle Connector  2 x  3 Quadruple"), "Connector")

    def test_motor_into_electric(self):
        self.assertEqual(categorize("Electric Power Functions Servo Motor Case"), "Electric")
        self.assertEqual(categorize("Battery Box 9V"), "Electric")

    def test_keyword_buckets(self):
        cases = [
            ("Technic Gear  8 Tooth Reinforced", "Gear"),
            ("Technic Beam  5 x  0.5 Liftarm", "Beam"),
            ("Technic Panel Smooth 11 x  2", "Panel"),
            ("Technic Wheel Hub", "Wheel"),
            ("Technic Brick Modified", "Brick"),
            ("Technic Tile  1 x  4", "Tile"),
            ("Technic Cylinder  6L Plain", "Cylinder"),
            ("Pneumatic Tube 11L", "Pneumatic"),
            ("Steering Wheel Bearing", "Pin"),  # "Wheel" hits first? 不 — "Steering" 优先
        ]
        # "Steering Wheel Bearing" — 'steering' 早于 'wheel'，应进 Steering
        self.assertEqual(categorize("Steering Wheel Bearing"), "Steering")
        for desc, expected in cases[:-1]:
            with self.subTest(desc=desc):
                self.assertEqual(categorize(desc), expected)

    def test_unknown_falls_to_other(self):
        self.assertEqual(categorize("Excavator Bucket 23 x 13"), "Other")
        self.assertEqual(categorize("Action Figure Torso"), "Other")

    def test_category_order_contains_all_known_buckets(self):
        # 任何 categorize() 可能产出的桶都必须出现在 CATEGORY_ORDER 中（防止前端漏渲染）
        produced = set()
        descriptions = [
            "Pin", "Axle", "Pneumatic Hose", "Servo Motor", "Steering Bearing",
            "Axle Connector", "Tooth Gear", "Wheel Hub", "Beam Liftarm",
            "Panel Fairing", "Brick", "Plate", "Tile", "Shock Absorber",
            "Sticker Sheet", "RoboRider Container",
        ]
        for d in descriptions:
            produced.add(categorize(d))
        for cat in produced:
            self.assertIn(cat, CATEGORY_ORDER, msg=f"category {cat!r} 未声明顺序")


class TestGetPartName(unittest.TestCase):
    def test_missing_file_returns_part_id(self):
        self.assertEqual(get_part_name("nonexistent.dat", "/no/such/dir"), "nonexistent.dat")

    def test_empty_part_id_returns_empty(self):
        self.assertEqual(get_part_name("", "/whatever"), "")

    def test_reads_first_line_comment(self):
        with TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "fake.dat")
            with open(path, "w", encoding="utf-8") as f:
                f.write("0 Technic Custom Test Part\n1 16 0 0 0 ...\n")
            # 注意 lru_cache 会按 (part_id, dir) 缓存；TemporaryDirectory 名称随机不会撞缓存
            self.assertEqual(get_part_name("fake.dat", tmp), "Technic Custom Test Part")

    def test_malformed_first_line_falls_back_to_part_id(self):
        with TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "weird.dat")
            with open(path, "w", encoding="utf-8") as f:
                f.write("garbage line without 0-prefix\n")
            self.assertEqual(get_part_name("weird.dat", tmp), "weird.dat")


class TestCategorizePart(unittest.TestCase):
    def test_one_shot_name_and_category(self):
        with TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "p.dat"), "w", encoding="utf-8") as f:
                f.write("0 Technic Pin 3L\n")
            name, cat = categorize_part("p.dat", tmp)
            self.assertEqual(name, "Technic Pin 3L")
            self.assertEqual(cat, "Pin")


if __name__ == "__main__":
    unittest.main()

"""
test_port_library_manager.py
=============================
对 PortLibraryManager 的持久化层进行全覆盖单元测试。

覆盖范围：
  - load：新文件初始化、正常加载、JSON 解析失败
  - save：原子性写入（tmp → replace）、写入内容验证
  - get_part_data：命中/缺失/ID 大小写归一化
  - update_part：verified 防护、force 覆盖、时间戳注入
  - update_part_config：Sites 写入、旧 ports 字段清理
  - get_pending_parts / get_verified_parts：排序与过滤
  - delete_part：存在/不存在边界
  - 线程并发：多线程写入不产生数据污染
"""

import json
import os
import sys
import threading
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.port_library_manager import PortLibraryManager


# ── 辅助工厂 ──────────────────────────────────────────────────────────────────

def _make_site(part_id: str, port_type: str = "peghole.dat") -> dict:
    """构造最基础的 Site 字典（用于测试输入）。"""
    return {
        "id": f"{part_id}_site0",
        "position": [0.0, 0.0, 0.0],
        "occupied_by": None,
        "ports": [
            {
                "name": f"{part_id}_p0",
                "type": port_type,
                "position": [0.0, 0.0, 0.0],
                "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "is_manually_adjusted": False,
            }
        ],
    }


def _make_config(status: str = "pending", verified: bool = False) -> dict:
    """构造一个最小化的零件配置字典。"""
    return {
        "version": "v3.1.sites",
        "status": status,
        "verified": verified,
        "confidence": 0.9,
        "sites": [_make_site("test_part")],
    }


# ── 测试套件 ──────────────────────────────────────────────────────────────────

class TestPortLibraryManagerLoad(unittest.TestCase):
    """load() 方法测试。"""

    def test_load_nonexistent_file_initializes_empty(self):
        """[Load-1] 不存在的文件路径应初始化为空字典，不抛异常。"""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "nonexistent.json")
            mgr = PortLibraryManager(config_path=path)
            self.assertEqual(mgr._data, {}, "文件不存在时 _data 应为空字典。")

    def test_load_valid_json_file(self):
        """[Load-2] 正常 JSON 文件应被完整加载。"""
        initial = {"32316.dat": _make_config("verified", True)}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(initial, f)
            path = f.name
        try:
            mgr = PortLibraryManager(config_path=path)
            self.assertIn("32316.dat", mgr._data)
            self.assertEqual(mgr._data["32316.dat"]["status"], "verified")
        finally:
            os.unlink(path)

    def test_load_invalid_json_raises_runtime_error(self):
        """[Load-3] 损坏的 JSON 文件应抛出 RuntimeError（不吞掉异常）。"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            f.write("{ broken json }")
            path = f.name
        try:
            with self.assertRaises(RuntimeError):
                PortLibraryManager(config_path=path)
        finally:
            os.unlink(path)


class TestPortLibraryManagerSave(unittest.TestCase):
    """save() 方法测试。"""

    def setUp(self):
        self._tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        )
        json.dump({}, self._tmp)
        self._tmp.flush()
        self._tmp.close()
        self.mgr = PortLibraryManager(config_path=self._tmp.name)

    def tearDown(self):
        if os.path.exists(self._tmp.name):
            os.unlink(self._tmp.name)

    def test_save_writes_correct_content(self):
        """[Save-1] save() 应将 _data 原子性写入磁盘，内容可用 json.load 读回。"""
        self.mgr._data["6558.dat"] = _make_config("pending")
        self.mgr.save()

        with open(self._tmp.name, "r", encoding="utf-8") as f:
            on_disk = json.load(f)
        self.assertIn("6558.dat", on_disk)
        self.assertEqual(on_disk["6558.dat"]["status"], "pending")

    def test_save_no_tmp_file_left(self):
        """[Save-2] 正常写入后不应留下 .tmp 中间文件。"""
        self.mgr.save()
        tmp_path = f"{self._tmp.name}.tmp"
        self.assertFalse(os.path.exists(tmp_path), ".tmp 中间文件应在 save() 后被清理。")


class TestPortLibraryManagerGetPartData(unittest.TestCase):
    """get_part_data() 方法测试。"""

    def setUp(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump({"32316.dat": _make_config("pending")}, f)
            self.path = f.name
        self.mgr = PortLibraryManager(config_path=self.path)

    def tearDown(self):
        os.unlink(self.path)

    def test_get_existing_part(self):
        """[GetData-1] 命中已有零件应返回其完整配置副本。"""
        data = self.mgr.get_part_data("32316.dat")
        self.assertIsNotNone(data)
        self.assertEqual(data["status"], "pending")

    def test_get_missing_part_returns_none(self):
        """[GetData-2] 查询不存在的零件应返回 None。"""
        self.assertIsNone(self.mgr.get_part_data("ghost_part.dat"))

    def test_get_part_data_is_deep_copy(self):
        """[GetData-3] 返回的副本修改不应影响内部 _data（防止外部污染）。"""
        data = self.mgr.get_part_data("32316.dat")
        self.assertIsNotNone(data)
        data["status"] = "MUTATED"
        self.assertEqual(self.mgr._data["32316.dat"]["status"], "pending",
                         "外部修改返回值不应影响内部数据存储。")

    def test_id_normalization_case_insensitive(self):
        """[GetData-4] 零件 ID 大小写归一化：'32316' 和 '32316.DAT' 应等价。"""
        self.assertIsNotNone(self.mgr.get_part_data("32316"))
        self.assertIsNotNone(self.mgr.get_part_data("32316.DAT"))


class TestPortLibraryManagerUpdatePart(unittest.TestCase):
    """update_part() 方法测试。"""

    def setUp(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            initial = {
                "32316.dat": _make_config("pending", False),
                "6558.dat":  _make_config("verified", True),
            }
            json.dump(initial, f)
            self.path = f.name
        self.mgr = PortLibraryManager(config_path=self.path)

    def tearDown(self):
        os.unlink(self.path)

    def test_update_pending_part_succeeds(self):
        """[Update-1] pending 状态零件更新应成功（返回 True）。"""
        new_data = _make_config("pending")
        result = self.mgr.update_part("32316.dat", new_data, force=False)
        self.assertTrue(result)

    def test_update_injects_baked_at_timestamp(self):
        """[Update-2] 任何写入都应自动注入 baked_at 时间戳。"""
        self.mgr.update_part("32316.dat", _make_config("pending"), force=False)
        self.assertIn("baked_at", self.mgr._data["32316.dat"],
                      "update_part 应自动注入 baked_at 时间戳。")

    def test_update_verified_without_force_is_blocked(self):
        """[Update-3] 不带 force 更新 verified 零件应被拦截（返回 False）。"""
        result = self.mgr.update_part("6558.dat", _make_config("verified"), force=False)
        self.assertFalse(result, "未使用 force 标志时，verified 零件更新应被拒绝。")

    def test_update_verified_with_force_succeeds(self):
        """[Update-4] 带 force=True 更新 verified 零件应覆盖成功。"""
        new_data = _make_config("pending")  # 强制改回 pending
        result = self.mgr.update_part("6558.dat", new_data, force=True)
        self.assertTrue(result, "force=True 时应允许覆盖 verified 零件。")
        self.assertEqual(self.mgr._data["6558.dat"]["status"], "pending")


class TestPortLibraryManagerUpdatePartConfig(unittest.TestCase):
    """update_part_config() 方法测试（复核接口）。"""

    def setUp(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            # 包含旧 ports 字段的遗留数据
            initial = {
                "old_part.dat": {
                    "status": "pending",
                    "confidence": 0.5,
                    "verified": False,
                    "ports": [{"name": "old_p", "type": "peghole.dat"}],  # 旧扁平字段
                    "sites": [],
                }
            }
            json.dump(initial, f)
            self.path = f.name
        self.mgr = PortLibraryManager(config_path=self.path)

    def tearDown(self):
        os.unlink(self.path)

    def test_update_part_config_sets_verified_status(self):
        """[Config-1] 提交复核应将 status 设置为 'verified'，verified=True。"""
        sites = [_make_site("old_part")]
        result = self.mgr.update_part_config("old_part.dat", sites, "verified", 1.0, force=True)
        self.assertTrue(result)
        cfg = self.mgr._data["old_part.dat"]
        self.assertEqual(cfg["status"], "verified")
        self.assertTrue(cfg["verified"])

    def test_update_part_config_removes_old_flat_ports(self):
        """[Config-2] 复核写入后，旧扁平 ports 字段应被清除（强制迁移到 Sites 结构）。"""
        sites = [_make_site("old_part")]
        self.mgr.update_part_config("old_part.dat", sites, "verified", 1.0, force=True)
        self.assertNotIn("ports", self.mgr._data["old_part.dat"],
                         "提交复核后旧扁平 ports 字段应从配置中移除。")

    def test_update_part_config_stores_sites(self):
        """[Config-3] 复核写入的 Sites 数据应被完整保留。"""
        sites = [_make_site("old_part", "axlehole.dat")]
        self.mgr.update_part_config("old_part.dat", sites, "verified", 1.0, force=True)
        stored = self.mgr._data["old_part.dat"]["sites"]
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["ports"][0]["type"], "axlehole.dat")


class TestPortLibraryManagerQueryMethods(unittest.TestCase):
    """get_pending_parts() 与 get_verified_parts() 的过滤和排序测试。"""

    def setUp(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            initial = {
                "a.dat": {"status": "pending", "confidence": 0.3, "verified": False,
                           "sites": [_make_site("a")]},
                "b.dat": {"status": "pending", "confidence": 0.8, "verified": False,
                           "sites": [_make_site("b"), _make_site("b")]},
                "c.dat": {"status": "verified", "confidence": 1.0, "verified": True,
                           "sites": [_make_site("c")]},
            }
            json.dump(initial, f)
            self.path = f.name
        self.mgr = PortLibraryManager(config_path=self.path)

    def tearDown(self):
        os.unlink(self.path)

    def test_get_pending_parts_excludes_verified(self):
        """[Query-1] get_pending_parts 不应包含 verified 零件。"""
        pending = self.mgr.get_pending_parts()
        ids = [p["part_id"] for p in pending]
        self.assertNotIn("c.dat", ids)

    def test_get_pending_parts_sorted_by_confidence_asc(self):
        """[Query-2] get_pending_parts 应按 confidence 升序排列（低置信度优先）。"""
        pending = self.mgr.get_pending_parts()
        self.assertEqual(pending[0]["part_id"], "a.dat",
                         "confidence=0.3 的零件应排在最前。")

    def test_get_pending_parts_port_count_from_sites(self):
        """[Query-3] port_count 应从 sites 的端口总数计算（b.dat 有 2 个 site, 各 1 port = 2）。"""
        pending = {p["part_id"]: p for p in self.mgr.get_pending_parts()}
        self.assertEqual(pending["b.dat"]["port_count"], 2)

    def test_get_verified_parts_only_returns_verified(self):
        """[Query-4] get_verified_parts 只应返回 status='verified' 的零件。"""
        verified = self.mgr.get_verified_parts()
        for v in verified:
            self.assertEqual(self.mgr._data[v["part_id"]]["status"], "verified")

    def test_get_verified_parts_sorted_by_part_id(self):
        """[Query-5] get_verified_parts 应按 part_id 字母排序。"""
        # 在已有基础上再增加一个
        self.mgr._data["aa.dat"] = {
            "status": "verified", "confidence": 1.0, "verified": True,
            "sites": [_make_site("aa")],
        }
        verified = self.mgr.get_verified_parts()
        ids = [v["part_id"] for v in verified]
        self.assertEqual(ids, sorted(ids), "get_verified_parts 应按 part_id 升序排列。")


class TestPortLibraryManagerDeletePart(unittest.TestCase):
    """delete_part() 方法测试。"""

    def setUp(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump({"del.dat": _make_config("pending")}, f)
            self.path = f.name
        self.mgr = PortLibraryManager(config_path=self.path)

    def tearDown(self):
        os.unlink(self.path)

    def test_delete_existing_part(self):
        """[Delete-1] 删除存在的零件应返回 True 且从 _data 中移除。"""
        result = self.mgr.delete_part("del.dat")
        self.assertTrue(result)
        self.assertNotIn("del.dat", self.mgr._data)

    def test_delete_nonexistent_part_returns_false(self):
        """[Delete-2] 删除不存在的零件应返回 False，不抛异常。"""
        result = self.mgr.delete_part("ghost.dat")
        self.assertFalse(result)


class TestPortLibraryManagerConcurrency(unittest.TestCase):
    """线程安全性测试：并发写入不产生数据污染。"""

    def test_concurrent_updates_are_thread_safe(self):
        """[Concurrent-1] 多线程并发 update_part 后，所有写入均应成功且数据完整。"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump({}, f)
            path = f.name
        mgr = PortLibraryManager(config_path=path)
        errors = []

        def _writer(part_id: str) -> None:
            try:
                mgr.update_part(part_id, _make_config("pending"), force=True)
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=_writer, args=(f"p{i}.dat",)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [], f"并发写入出现异常: {errors}")
        self.assertEqual(len(mgr._data), 20, "并发写入后应有 20 条零件记录。")
        os.unlink(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)

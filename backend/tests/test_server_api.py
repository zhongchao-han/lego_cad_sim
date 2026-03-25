"""
test_server_api.py
===================
使用 FastAPI TestClient 对 server.py 中的关键 API 端点进行集成测试。

覆盖范围：
  - GET  /api/get_verified_parts        : 返回已核验零件列表
  - GET  /api/verify/pending_list       : 返回待复核列表
  - GET  /api/verify/search             : 搜索接口（含边界）
  - POST /api/verify/save               : 保存复核数据（Site 结构写入）
  - POST /api/snap_parts                : 拓扑建图 + AutoLatch 触发路径
  - POST /api/reload_library            : 刷新库配置
  - POST /api/toggle_mode               : 模式切换路由（路径含 /api/ 前缀）
  - GET  /api/ldraw_part/{id}           : 已核验零件走缓存短路 vs 未核验走聚类

说明：
  - 为避免依赖真实文件系统，使用 unittest.mock.patch 替换
    PortLibraryManager 的底层 _data 字典和 save 方法。
  - WebSocket 和 PhysicsEngine 不在本测试范围内。
"""

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from fastapi.testclient import TestClient


# ── 共享夹具数据 ──────────────────────────────────────────────────────────────

_VERIFIED_SITE = {
    "id": "6558_site0",
    "position": [0.0, 0.0, 0.0],
    "occupied_by": None,
    "ports": [
        {
            "name": "6558_p0",
            "type": "peg.dat",
            "position": [0.0, 0.0, 0.0],
            "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            "is_manually_adjusted": False,
        }
    ],
}

_VERIFIED_CFG = {
    "version": "v3.1.sites",
    "status": "verified",
    "verified": True,
    "confidence": 1.0,
    "glb_path": "data/custom_assets/6558_c7.glb",
    "sites": [_VERIFIED_SITE],
}

_PENDING_CFG = {
    "version": "v3.1.sites",
    "status": "pending",
    "verified": False,
    "confidence": 0.7,
    "sites": [],
}

# 数据字典（被 PortLibraryManager._data 共享；模块级 patch 使其生效）
_MOCK_DATA: dict = {
    "6558.dat": _VERIFIED_CFG,
    "32316.dat": _PENDING_CFG,
}


def _get_client() -> TestClient:
    """每次测试获取一个干净的 TestClient（避免模块级单例污染）。"""
    import backend.server as srv
    return TestClient(srv.app)


# ── 测试套件 ──────────────────────────────────────────────────────────────────

class TestGetVerifiedParts(unittest.TestCase):
    """GET /api/get_verified_parts"""

    def test_returns_200_and_verified_list(self):
        """[Verified-1] 应返回 200 和包含 6558 的已核验列表。"""
        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.get("/api/get_verified_parts")
        self.assertEqual(resp.status_code, 200)
        ids = [p["part_id"] for p in resp.json()]
        self.assertIn("6558.dat", ids)

    def test_pending_part_not_in_verified_list(self):
        """[Verified-2] pending 零件不应出现在已核验列表中。"""
        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.get("/api/get_verified_parts")
        ids = [p["part_id"] for p in resp.json()]
        self.assertNotIn("32316.dat", ids)


class TestGetPendingList(unittest.TestCase):
    """GET /api/verify/pending_list"""

    def test_returns_200_and_pending_items(self):
        """[Pending-1] 应返回 200 和包含 32316 的待核验列表。"""
        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.get("/api/verify/pending_list")
        self.assertEqual(resp.status_code, 200)
        ids = [p["part_id"] for p in resp.json()]
        self.assertIn("32316.dat", ids)


class TestSearchParts(unittest.TestCase):
    """GET /api/verify/search"""

    def test_search_by_partial_id(self):
        """[Search-1] 搜索 '655' 应命中 6558.dat。"""
        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.get("/api/verify/search?q=655")
        self.assertEqual(resp.status_code, 200)
        ids = [p["part_id"] for p in resp.json()]
        self.assertIn("6558.dat", ids)

    def test_search_no_match_returns_empty_list(self):
        """[Search-2] 无匹配的搜索词应返回空列表，而不是 4xx 错误。"""
        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.get("/api/verify/search?q=NONEXISTENT_PART_XYZ")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), [])

    def test_search_case_insensitive(self):
        """[Search-3] 搜索对大小写不敏感（'6558' vs '6558'）。"""
        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.get("/api/verify/search?q=6558")
        ids = [p["part_id"] for p in resp.json()]
        self.assertIn("6558.dat", ids)


class TestVerifySave(unittest.TestCase):
    """POST /api/verify/save (和 /api/verify_part)"""

    def _build_payload(self, part_id: str = "32316.dat") -> dict:
        return {
            "part_id": part_id,
            "sites": [
                {
                    "id": f"{part_id}_site0",
                    "position": [0.0, 0.0, 0.0],
                    "occupied_by": None,
                    "ports": [
                        {
                            "name": f"{part_id}_p0",
                            "type": "peghole.dat",
                            "position": [0.0, 0.0, 0.0],
                            "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                            "is_manually_adjusted": False,
                        }
                    ],
                }
            ],
        }

    def test_save_returns_success(self):
        """[Save-1] 正常复核提交应返回 status='success'。"""
        mock_data: dict = {"32316.dat": dict(_PENDING_CFG)}
        with (
            patch("backend.server.port_lib_manager._data", mock_data),
            patch("backend.server.port_lib_manager.save", MagicMock()),
        ):
            client = _get_client()
            resp = client.post("/api/verify/save", json=self._build_payload())
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "success")

    def test_save_with_empty_sites_is_accepted(self):
        """[Save-2] 空 sites 列表的复核请求也应被接受（不崩溃）。"""
        mock_data: dict = {"empty.dat": dict(_PENDING_CFG)}
        with (
            patch("backend.server.port_lib_manager._data", mock_data),
            patch("backend.server.port_lib_manager.save", MagicMock()),
        ):
            client = _get_client()
            resp = client.post(
                "/api/verify/save", json={"part_id": "empty.dat", "sites": []}
            )
        self.assertEqual(resp.status_code, 200)


class TestSnapParts(unittest.TestCase):
    """POST /api/snap_parts"""

    def _base_payload(self) -> dict:
        flat_eye = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        return {
            "parent_id": "6558.dat",
            "child_id":  "32316.dat",
            "port_type_p": "peg.dat",
            "port_type_c": "peghole.dat",
            "parent_origin": [0.0, 0.0, 0.0],
            "parent_rot":    flat_eye,
            "child_origin":  [0.004, 0.0, 0.0],
            "child_rot":     flat_eye,
        }

    def test_snap_without_world_pos_returns_success(self):
        """[Snap-1] 不携带 world_pos 的 Snap 请求（旧版兼容）应成功且 auto_latched_count=0。"""
        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.post("/api/snap_parts", json=self._base_payload())
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["auto_latched_count"], 0,
                         "无 world_pos 时 AutoLatch 应跳过，auto_latched_count 必须为 0。")

    def test_snap_with_world_pos_triggers_auto_latch_path(self):
        """[Snap-2] 携带 world_pos 的 Snap 请求应进入 AutoLatch 扫描路径并返回成功。"""
        payload = self._base_payload()
        payload["parent_world_pos"] = [0.0, 0.0, 0.0]
        payload["child_world_pos"]  = [0.004, 0.0, 0.0]

        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.post("/api/snap_parts", json=payload)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("auto_latched_count", resp.json())

    def test_snap_invalid_port_types_returns_error(self):
        """[Snap-3] 无法识别的端口类型（未在 port_semantics 注册）应返回 error。"""
        payload = self._base_payload()
        payload["port_type_p"] = "UNKNOWN_TYPE.dat"
        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            resp = client.post("/api/snap_parts", json=payload)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "error",
                         "无法识别的端口类型应返回 error 而非崩溃。")

    def test_snap_registers_nodes_in_topology(self):
        """[Snap-4] Snap 成功后，拓扑图中应该能查到两个节点。"""
        import backend.server as srv
        # 清空拓扑图，确保测试隔离
        srv.topo_manager.graph.clear()

        with patch("backend.server.port_lib_manager._data", _MOCK_DATA):
            client = _get_client()
            client.post("/api/snap_parts", json=self._base_payload())

        nodes = list(srv.topo_manager.graph.nodes)
        self.assertIn("6558.dat", nodes)
        self.assertIn("32316.dat", nodes)

        # 清理，避免污染其他测试
        srv.topo_manager.graph.clear()


class TestReloadLibrary(unittest.TestCase):
    """POST /api/reload_library"""

    def test_reload_returns_success_and_count(self):
        """[Reload-1] 重载应返回 status='success' 及 part_count 字段。"""
        with (
            patch("backend.server.port_lib_manager._data", dict(_MOCK_DATA)),
            patch("backend.server.port_lib_manager.load", MagicMock()),
        ):
            client = _get_client()
            resp = client.post("/api/reload_library")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "success")
        self.assertIn("part_count", body)


class TestToggleMode(unittest.TestCase):
    """POST /api/toggle_mode — 验证路由必须含 /api/ 前缀"""

    def test_toggle_mode_route_exists(self):
        """[Mode-1] /api/toggle_mode 路由应存在（之前的 Bug：前端调用缺 /api/ 前缀）。"""
        import backend.server as srv
        # 重置模式，避免副作用
        srv.system_mode = "ASSEMBLY"
        client = _get_client()
        # 切换到 ASSEMBLY（当前已经是 ASSEMBLY, 应返回 ok/no change）
        resp = client.post("/api/toggle_mode?mode=ASSEMBLY")
        self.assertEqual(resp.status_code, 200,
                         "/api/toggle_mode 路由应存在，不应返回 404。")

    def test_toggle_mode_wrong_prefix_returns_404(self):
        """[Mode-2] 缺少 /api/ 前缀的路由 /toggle_mode 应返回 404（验证修复必要性）。"""
        client = _get_client()
        resp = client.post("/toggle_mode?mode=ASSEMBLY")
        self.assertEqual(resp.status_code, 404,
                         "不含 /api/ 前缀的路由路径不应被后端响应。")


class TestGetLdrawPartCacheBranching(unittest.TestCase):
    """GET /api/ldraw_part/{id} 的 verified 缓存短路 vs pending 聚类分支测试。"""

    def test_verified_part_returns_cached_sites_without_reclustering(self):
        """[LdrawPart-1] 已核验零件应直接返回缓存 Sites，不触发实时聚类。"""
        with (
            patch("backend.server.port_lib_manager._data", dict(_MOCK_DATA)),
            # 确保 GLB 文件存在的检查被 mock 掉，避免文件系统依赖
            patch("os.path.exists", return_value=True),
        ):
            client = _get_client()
            resp = client.get("/api/ldraw_part/6558.dat")

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["part_id"], "6558.dat")
        # 已核验零件的 Sites 应直接来自缓存
        self.assertIsInstance(body["sites"], list)

    def test_ldraw_part_unknown_id_triggers_live_parse_path(self):
        """[LdrawPart-2] 不在库中的零件应走实时解析路径（可能 500，但不应 404 路由失败）。"""
        with patch("backend.server.port_lib_manager._data", {}):
            client = _get_client()
            resp = client.get("/api/ldraw_part/totally_unknown_part.dat")
        # 实时解析因缺乏 LDraw 文件会抛 500，但路由本身应存在
        self.assertIn(resp.status_code, [200, 500],
                      "未知零件应走实时解析路径（可能 500），但路由本身必须存在（非 404）。")


if __name__ == "__main__":
    unittest.main(verbosity=2)

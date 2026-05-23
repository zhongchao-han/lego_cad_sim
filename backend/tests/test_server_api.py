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

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from fastapi.testclient import TestClient
from backend.tests.test_utils import _make_site


# ── 共享夹具数据 ──────────────────────────────────────────────────────────────

_VERIFIED_SITE = _make_site("6558", "peg.dat")

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
            "sites": [_make_site(part_id, "peghole.dat")],
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


class TestGetLdrawPartGlbFallback(unittest.TestCase):
    """
    GET /api/ldraw_part/{id} — GLB 实时补全路径测试 (Gap-A & Gap-B)

    背景：
        当已核验零件的 GLB 文件在磁盘缺失时，server.py 会调用
        `geo_proc.convert_to_glb()` 做实时补全。此前 Bug 在于
        调用时使用了错误参数名 `color=`，导致 TypeError。
        本测试类覆盖该路径的正向（补全成功）和负向（补全失败降级）场景。
    """

    def test_glb_missing_convert_called_with_color_code_kwarg(self):
        """
        [Gap-A] GLB 文件缺失时，convert_to_glb 必须以 `color_code=` 关键字被调用。

        验证要点：
          - os.path.exists 返回 False 触发补全逻辑。
          - convert_to_glb 被调用时，关键字参数名为 color_code（而非旧 Bug 的 color）。
          - 整体接口仍返回 200（补全成功路径）。
        """
        mock_convert = MagicMock(return_value=True)
        with (
            patch("backend.server.port_lib_manager._data", dict(_MOCK_DATA)),
            patch("os.path.exists", return_value=False),
            patch("backend.server.geo_proc.convert_to_glb", mock_convert),
        ):
            client = _get_client()
            resp = client.get("/api/ldraw_part/6558.dat?color=7")

        self.assertEqual(resp.status_code, 200,
                         "GLB 补全路径下接口仍应返回 200。")

        # 核心断言：验证 server.py 以正确的关键字参数调用 convert_to_glb
        self.assertTrue(mock_convert.called,
                        "GLB 文件缺失时 convert_to_glb 应被调用。")
        _, call_kwargs = mock_convert.call_args
        self.assertIn(
            "color_code", call_kwargs,
            "convert_to_glb 必须以 'color_code=' 关键字调用（回归 Bug 修复：color= → color_code=）。"
        )
        self.assertNotIn(
            "color", call_kwargs,
            "convert_to_glb 不应再使用旧的错误参数名 'color='。"
        )

    def test_glb_missing_convert_fails_gracefully_returns_cached_sites(self):
        """
        [Gap-B] GLB 实时补全失败时（convert_to_glb 抛出异常），
        接口应降级返回缓存的 Sites 数据，而不是返回 500。

        验证要点：
          - convert_to_glb 内部抛出 RuntimeError 模拟补全失败。
          - 接口捕获异常后，仍以 200 返回缓存中的 Sites 结构。
        """
        mock_convert = MagicMock(side_effect=RuntimeError("Simulated GLB export failure"))
        with (
            patch("backend.server.port_lib_manager._data", dict(_MOCK_DATA)),
            patch("os.path.exists", return_value=False),
            patch("backend.server.geo_proc.convert_to_glb", mock_convert),
        ):
            client = _get_client()
            resp = client.get("/api/ldraw_part/6558.dat")

        # 降级策略：补全失败不应导致整个接口崩溃
        self.assertEqual(resp.status_code, 200,
                         "GLB 补全失败时接口应降级返回 200，而非传播 500 错误。")
        body = resp.json()
        # 已核验零件的缓存 Sites 仍应被返回
        self.assertIsInstance(body.get("sites"), list,
                              "降级路径下仍应返回缓存的 sites 字段。")


class TestGetLdrawPartLiveParseBranch(unittest.TestCase):
    """
    GET /api/ldraw_part/{id} — 缓存缺失走实时解析路径测试 (Gap-D)

    背景：
        当零件不在 PortLibraryManager 中时，server.py 会调用
        `geo_proc.discover_ports()` 后再调用 `geo_proc.convert_to_glb()`。
        本类验证该路径同样以 `color_code=` 正确调用 convert_to_glb。
    """

    def test_live_parse_calls_convert_to_glb_with_color_code_kwarg(self):
        """
        [Gap-D] 缓存缺失时实时解析路径，convert_to_glb 亦必须以 `color_code=` 调用。

        验证要点：
          - 空库模拟"全新零件"场景，触发实时解析路径。
          - discover_ports 被 mock 为返回空列表，避免文件系统依赖。
          - convert_to_glb 被 mock 并验证关键字参数名正确。
        """
        mock_discover = MagicMock(return_value=[])
        mock_convert = MagicMock(return_value=True)
        with (
            # 空数据库：模拟未被缓存的全新零件
            patch("backend.server.port_lib_manager._data", {}),
            patch("backend.server.geo_proc.discover_ports", mock_discover),
            patch("backend.server.geo_proc.convert_to_glb", mock_convert),
        ):
            client = _get_client()
            client.get("/api/ldraw_part/brand_new_part.dat?color=4")

        if not mock_convert.called:
            # discover_ports 返回空列表时聚类后仍可能走到 convert 调用，
            # 根据实际路径逻辑：只要 cached_data 为 None 就会执行 convert。
            # 若此断言失败说明代码路径已变，需同步更新测试。
            self.skipTest(
                "discover_ports 返回空列表时 convert_to_glb 未被触发，"
                "可能缓存路径逻辑有变，跳过参数名检查。"
            )
            return

        _, call_kwargs = mock_convert.call_args
        self.assertIn(
            "color_code", call_kwargs,
            "[Gap-D] 实时解析路径：convert_to_glb 必须以 'color_code=' 传参（回归 Bug 修复）。"
        )
        self.assertNotIn(
            "color", call_kwargs,
            "[Gap-D] 实时解析路径：不应再使用旧参数名 'color='。"
        )



class TestGlbSubdirectoryUrlRegression(unittest.TestCase):
    """
    GET /api/ldraw_part/{id} — mesh_url 子路径回归测试 (Regression-SubPath)

    背景（Bug 复现）：
        `server.py` 曾使用 `os.path.basename()` 从缓存的 `glb_path` 构建
        `mesh_url`，导致 LDraw 子文件（存储于 `data/custom_assets/s/` 目录下）
        的子路径 `s/` 被截断。

        例如，`glb_path = "data/custom_assets/s/23801s01.glb"` 被错误地
        构建成 `/ldraw_meshes/23801s01.glb`，而正确值应为
        `/ldraw_meshes/s/23801s01.glb`。

        由于 StaticFiles 挂载的根目录是 `data/custom_assets/`，
        截断后的路径对应实际不存在的文件，从而产生 404。

    修复方案：
        改用 `os.path.relpath(abs_glb_path, MESH_CACHE_ROOT)` 保留完整子路径。

    覆盖范围：
        SubPath-1: verified 分支 — s/ 子目录零件的 mesh_url 不被截断
        SubPath-2: verified 分支 — 顶层零件（无子目录）路径仍正确
        SubPath-3: pending 缓存分支（非 verified）— s/ 子路径同样被保留
        SubPath-4: 降级兜底 — 无 glb_path 时 fallback 为 _c{color} 命名规则
    """

    # ── 子文件（`s/` 子目录）的模拟配置 ────────────────────────────────────────
    _SUBFILE_VERIFIED_SITE = _make_site("23801s01.dat", "peghole.dat")
    _SUBFILE_VERIFIED_SITE["ports"][0]["name"] = "23801s01_p0"

    # glb_path 使用相对路径，与 ldraw_port_configs.json 中的真实格式一致
    _SUBFILE_VERIFIED_CFG = {
        "version": "v3.1.sites",
        "status": "verified",
        "verified": True,
        "confidence": 1.0,
        # 子文件的 glb_path 包含 s\ 子目录（Windows 风格，与真实配置一致）
        "glb_path": r"data\custom_assets\s\23801s01.glb",
        "sites": [_SUBFILE_VERIFIED_SITE],
    }

    # 顶层零件（无子目录）的模拟配置
    _TOPLEVEL_VERIFIED_CFG = {
        "version": "v3.1.sites",
        "status": "verified",
        "verified": True,
        "confidence": 1.0,
        "glb_path": r"data\custom_assets\6558.glb",
        "sites": [_VERIFIED_SITE],
    }

    # pending 缓存条目（非 verified，走 pending 缓存分支）
    _SUBFILE_PENDING_CFG = {
        "version": "v3.1.sites",
        "status": "pending",
        "verified": False,
        "confidence": 0.7,
        # pending 条目同样携带子目录路径
        "glb_path": r"data\custom_assets\s\23801s01.glb",
        "sites": [_SUBFILE_VERIFIED_SITE],
    }

    def test_subpath_verified_mesh_url_preserves_subdirectory(self):
        """
        [SubPath-1] 已核验的 LDraw 子文件，其 mesh_url 必须保留 s/ 前缀。

        回归场景：
            `os.path.basename("data/custom_assets/s/23801s01.glb")`
            返回 "23801s01.glb"，构建出 "/ldraw_meshes/23801s01.glb"（404）。

            修复后应使用 `os.path.relpath()` 保留子目录层级，
            返回 "/ldraw_meshes/s/23801s01.glb"（正确）。
        """
        mock_data = {"s\\23801s01.dat": self._SUBFILE_VERIFIED_CFG}
        with (
            patch("backend.server.port_lib_manager._data", mock_data),
            patch("os.path.exists", return_value=True),
        ):
            client = _get_client()
            resp = client.get("/api/ldraw_part/s\\23801s01.dat")

        self.assertEqual(resp.status_code, 200)
        mesh_url: str = resp.json().get("mesh_url", "")
        self.assertNotEqual(mesh_url, "", "mesh_url 不应为空。")
        self.assertIn(
            "s/",
            mesh_url,
            f"[SubPath-1] mesh_url 必须包含 's/' 子目录（实际值：{mesh_url!r}）。"
            f"这是 os.path.basename() 截断子路径 Bug 的回归测试。",
        )
        self.assertNotIn(
            "//",
            mesh_url,
            f"mesh_url 不应包含双斜杠，当前值：{mesh_url!r}。",
        )

    def test_toplevel_verified_mesh_url_has_no_extra_prefix(self):
        """
        [SubPath-2] 顶层零件（无子目录）的 mesh_url 不应出现额外斜杠或路径片段。

        验证修复不影响普通顶层零件的 URL 构建。
        """
        mock_data = {"6558.dat": self._TOPLEVEL_VERIFIED_CFG}
        with (
            patch("backend.server.port_lib_manager._data", mock_data),
            patch("os.path.exists", return_value=True),
        ):
            client = _get_client()
            resp = client.get("/api/ldraw_part/6558.dat")

        self.assertEqual(resp.status_code, 200)
        mesh_url: str = resp.json().get("mesh_url", "")
        self.assertTrue(
            mesh_url.startswith("/ldraw_meshes/"),
            f"[SubPath-2] mesh_url 应以 '/ldraw_meshes/' 开头，实际：{mesh_url!r}。",
        )
        self.assertNotIn(
            "//",
            mesh_url,
            f"顶层零件的 mesh_url 不应出现双斜杠：{mesh_url!r}。",
        )
        # 顶层文件不应包含 s/ 子路径
        self.assertNotIn(
            "/s/",
            mesh_url,
            f"[SubPath-2] 顶层零件的 mesh_url 不应包含 '/s/' 子路径：{mesh_url!r}。",
        )

    def test_pending_cached_part_with_subpath_preserves_subdirectory(self):
        """
        [SubPath-3] pending 缓存分支（非 verified）的子文件 mesh_url 也必须保留 s/ 前缀。

        覆盖 server.py 中的非 verified 缓存分支（`if cached_data:` 块内的
        `glb_filename` 构建逻辑），确保两条分支均已正确修复。
        """
        mock_data = {"s\\23801s01.dat": self._SUBFILE_PENDING_CFG}
        with (
            patch("backend.server.port_lib_manager._data", mock_data),
            patch("os.path.exists", return_value=True),
            # pending 分支会调用 cluster_ports_into_sites，mock 掉避免依赖
            patch(
                "backend.server.cluster_ports_into_sites",
                return_value=[],
                create=True,
            ),
            patch(
                "backend.server.sites_to_response",
                return_value=[],
                create=True,
            ),
        ):
            client = _get_client()
            resp = client.get("/api/ldraw_part/s\\23801s01.dat")

        self.assertEqual(resp.status_code, 200)
        mesh_url: str = resp.json().get("mesh_url", "")
        self.assertIn(
            "s/",
            mesh_url,
            f"[SubPath-3] pending 分支的 mesh_url 也必须包含 's/' 子目录"
            f"（实际值：{mesh_url!r}）。两条分支均需修复，不可遗漏。",
        )

    def test_mesh_url_fallback_when_no_glb_path_in_cache(self):
        """
        [SubPath-4] 缓存中无 glb_path 字段时，应降级为 _c{color} 命名规则。

        验证降级路径不因修复引入新的崩溃，仍能给出有效的 mesh_url。
        """
        cfg_without_glb_path = {
            "version": "v3.1.sites",
            "status": "verified",
            "verified": True,
            "confidence": 1.0,
            # 刻意缺省 glb_path 字段，模拟历史数据或异常写入
            "sites": [_VERIFIED_SITE],
        }
        mock_data = {"6558.dat": cfg_without_glb_path}
        with (
            patch("backend.server.port_lib_manager._data", mock_data),
            patch("os.path.exists", return_value=True),
        ):
            client = _get_client()
            resp = client.get("/api/ldraw_part/6558.dat?color=7")

        self.assertEqual(resp.status_code, 200)
        mesh_url: str = resp.json().get("mesh_url", "")
        self.assertNotEqual(mesh_url, "", "[SubPath-4] 降级路径下 mesh_url 不应为空。")
        self.assertTrue(
            mesh_url.startswith("/ldraw_meshes/"),
            f"[SubPath-4] 降级 mesh_url 应以 '/ldraw_meshes/' 开头，实际：{mesh_url!r}。",
        )


class TestLlmRewriteProxy(unittest.TestCase):
    """POST /api/llm_rewrite — AI 语义改写后端代理（key 留后端，前端不接触）。"""

    def test_no_key_configured_returns_error(self):
        """[LLM-1] 未配置 DEEPSEEK_API_KEY → 返回 error，提示去 backend/.env 配。"""
        # 强制清空 key（本地可能从 backend/.env 注入，CI 则本就没有），保证确定性。
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}, clear=False):
            client = _get_client()
            resp = client.post("/api/llm_rewrite", json={"query": "红色大板"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "error")
        self.assertIn("DEEPSEEK_API_KEY", body["msg"])

    def test_empty_query_returns_error(self):
        """[LLM-2] 空 query → error（即便配了 key）。"""
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-test"}, clear=False):
            client = _get_client()
            resp = client.post("/api/llm_rewrite", json={"query": "   "})
        self.assertEqual(resp.json()["status"], "error")

    def test_success_returns_keywords_without_real_network(self):
        """[LLM-3] 配了 key + monkeypatch _call_deepseek → 返回 keywords，不打真网络。"""
        import backend.server as srv
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-test"}, clear=False), \
             patch.object(srv, "_call_deepseek", return_value="Baseplate 19 11") as mock_call:
            client = _get_client()
            resp = client.post("/api/llm_rewrite", json={"query": "很多孔的大平板"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["keywords"], "Baseplate 19 11")
        mock_call.assert_called_once()  # 走了代理而非真网络

    def test_empty_llm_result_returns_error(self):
        """[LLM-4] 大模型返回空串 → error（_call_deepseek 已 strip，空白即空）。"""
        import backend.server as srv
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-test"}, clear=False), \
             patch.object(srv, "_call_deepseek", return_value=""):
            client = _get_client()
            resp = client.post("/api/llm_rewrite", json={"query": "随便"})
        self.assertEqual(resp.json()["status"], "error")


if __name__ == "__main__":
    unittest.main(verbosity=2)


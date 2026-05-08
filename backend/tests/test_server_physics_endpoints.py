"""
test_server_physics_endpoints.py
================================
audit Round 4 #3 — server.py 三块 0 测试空缺：
  - GET  /api/insertion_check    (参数化优先 + strict 拒绝降级)
  - POST /api/apply_force        (SIMULATION mode 才生效，其他 mode ignored)
  - WS   /ws/physics_stream      (broadcast loop + connect / disconnect)

PhysicsEngine / system_mode 都是 backend.server 模块级单例，patch 代替
真启动 pybullet 物理引擎。WebSocket 测用 FastAPI TestClient 同步上下文
管理器，配合 mock engine.get_state 验证 broadcast payload 形状。
"""

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from fastapi.testclient import TestClient


def _get_client() -> TestClient:
    import backend.server as srv
    return TestClient(srv.app)


# ─────────────────────────────────────────────────────────────────────────
# /api/insertion_check
# ─────────────────────────────────────────────────────────────────────────
class TestInsertionCheck(unittest.TestCase):
    """GET /api/insertion_check — 参数化优先 + strict mode 拒绝降级。"""

    def test_explicit_peg_hole_types_clearance_fit(self):
        """显式 peg_type=peg.dat + hole_type=peghole.dat → CLEARANCE fit。"""
        client = _get_client()
        resp = client.get(
            "/api/insertion_check",
            params={
                "peg_id": "2780", "hole_id": "71709",
                "peg_type": "peg.dat", "hole_type": "peghole.dat",
            },
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["fit_type"], "clearance")
        self.assertIn("interference_mm", body)
        self.assertIn("can_fully_insert", body)

    def test_friction_pin_friction_fit(self):
        """fric_pin.dat + peghole.dat → FRICTION fit。"""
        client = _get_client()
        resp = client.get(
            "/api/insertion_check",
            params={
                "peg_id": "X", "hole_id": "Y",
                "peg_type": "fric_pin.dat", "hole_type": "peghole.dat",
            },
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["fit_type"], "friction")

    def test_unknown_peg_returns_strict_error(self):
        """peg_type=nonexistent → strict mode 拒绝降级，返 method=strict_error。"""
        client = _get_client()
        resp = client.get(
            "/api/insertion_check",
            params={
                "peg_id": "ghost_peg", "hole_id": "Y",
                "peg_type": "nonexistent_type.dat", "hole_type": "peghole.dat",
            },
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "error")
        self.assertEqual(body["method"], "strict_error")
        self.assertIn("Missing parameterized definition", body["msg"])

    def test_peg_id_directly_resolvable_no_explicit_type(self):
        """不传 peg_type/hole_type，用 peg_id/hole_id 直接当 type 名查注册表。"""
        client = _get_client()
        resp = client.get(
            "/api/insertion_check",
            params={"peg_id": "peg.dat", "hole_id": "peghole.dat"},
        )
        self.assertEqual(resp.status_code, 200)
        # 仍能解析为 clearance（peg + peghole）
        self.assertEqual(resp.json()["fit_type"], "clearance")

    def test_incompatible_polarity_returns_incompatible(self):
        """两个 MALE port → incompatible（gender 极性不互补）。"""
        client = _get_client()
        resp = client.get(
            "/api/insertion_check",
            params={
                "peg_id": "p1", "hole_id": "p2",
                "peg_type": "peg.dat", "hole_type": "peg.dat",  # 都是 MALE
            },
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["fit_type"], "incompatible")


# ─────────────────────────────────────────────────────────────────────────
# /api/apply_force
# ─────────────────────────────────────────────────────────────────────────
class TestApplyForce(unittest.TestCase):
    """POST /api/apply_force — SIMULATION mode 才透传到 engine.apply_user_force。"""

    def setUp(self) -> None:
        # 默认 system_mode=ASSEMBLY；每个 test 之前重置确保隔离
        import backend.server as srv
        srv.system_mode = "ASSEMBLY"

    def test_assembly_mode_returns_ignored_no_engine_call(self):
        """system_mode=ASSEMBLY → 返 status=ignored，不调 engine。"""
        mock_engine = MagicMock()
        with patch("backend.server.engine", mock_engine):
            client = _get_client()
            resp = client.post(
                "/api/apply_force",
                json={"link_name": "rotor", "force": [1.0, 0.0, 0.0]},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "ignored")
        self.assertIn("SIMULATION mode", body["msg"])
        mock_engine.apply_user_force.assert_not_called()

    def test_simulation_mode_calls_engine_apply_user_force(self):
        """system_mode=SIMULATION → engine.apply_user_force 被调 + 返 success。"""
        import backend.server as srv
        srv.system_mode = "SIMULATION"
        mock_engine = MagicMock()
        with patch("backend.server.engine", mock_engine):
            client = _get_client()
            resp = client.post(
                "/api/apply_force",
                json={
                    "link_name": "rotor",
                    "force": [10.0, 5.0, 0.0],
                    "position": [0.1, 0.2, 0.3],
                },
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "success")
        mock_engine.apply_user_force.assert_called_once_with(
            "rotor", [10.0, 5.0, 0.0], [0.1, 0.2, 0.3],
        )
        # cleanup
        srv.system_mode = "ASSEMBLY"

    def test_position_default_zero(self):
        """position 字段不传 → 默认 [0,0,0]，仍传给 engine。"""
        import backend.server as srv
        srv.system_mode = "SIMULATION"
        mock_engine = MagicMock()
        with patch("backend.server.engine", mock_engine):
            client = _get_client()
            resp = client.post(
                "/api/apply_force",
                json={"link_name": "L", "force": [1.0, 0.0, 0.0]},
            )
        self.assertEqual(resp.status_code, 200)
        mock_engine.apply_user_force.assert_called_once()
        # 第三个 positional arg 应为 [0,0,0] 默认
        args, _ = mock_engine.apply_user_force.call_args
        self.assertEqual(args[2], [0, 0, 0])
        srv.system_mode = "ASSEMBLY"

    def test_missing_required_field_returns_422(self):
        """ForceRequest 缺 link_name → FastAPI 自动返 422 validation error。"""
        client = _get_client()
        resp = client.post(
            "/api/apply_force",
            json={"force": [1.0, 0.0, 0.0]},
        )
        self.assertEqual(resp.status_code, 422)


# ─────────────────────────────────────────────────────────────────────────
# /ws/physics_stream
# ─────────────────────────────────────────────────────────────────────────
class TestPhysicsStream(unittest.TestCase):
    """WebSocket /ws/physics_stream — connect → broadcast loop → disconnect。

    用 TestClient.websocket_connect 同步上下文管理器；mock engine.get_state
    返非空 dict 让 broadcast 触发,验 payload 形状。
    """

    def setUp(self) -> None:
        import backend.server as srv
        srv.system_mode = "ASSEMBLY"  # 默认非 SIMULATION，避免 step_n 调用

    def test_websocket_accepts_connection_and_broadcasts(self):
        """连接 → mock get_state 返 dict → 客户端收 1 帧 broadcast 含 mode + state。"""
        import backend.server as srv
        mock_state = {"base": {"position": [0, 0, 0.5], "quaternion": [0, 0, 0, 1]}}
        mock_engine = MagicMock()
        mock_engine.get_state.return_value = mock_state

        with patch("backend.server.engine", mock_engine):
            client = _get_client()
            with client.websocket_connect("/ws/physics_stream") as ws:
                # broadcast loop 每 1/60s 跑一次；接收第一帧
                msg = ws.receive_text()
                payload = json.loads(msg)
                self.assertEqual(payload["mode"], srv.system_mode)
                self.assertEqual(payload["state"], mock_state)

    def test_websocket_simulation_mode_calls_step_n(self):
        """system_mode=SIMULATION → step_n 被调（驱动物理积分）+ broadcast。"""
        import backend.server as srv
        srv.system_mode = "SIMULATION"
        mock_engine = MagicMock()
        mock_engine.get_state.return_value = {"base": {"position": [0, 0, 0]}}

        with patch("backend.server.engine", mock_engine):
            client = _get_client()
            with client.websocket_connect("/ws/physics_stream") as ws:
                ws.receive_text()  # 接 1 帧确保 server 走完一次 loop iteration
            mock_engine.step_n.assert_called()
            # 推 4 步是 server.py:736 的硬编码
            args, _ = mock_engine.step_n.call_args
            self.assertEqual(args[0], 4)
        srv.system_mode = "ASSEMBLY"

    def test_websocket_disconnect_removes_from_pool(self):
        """客户端断开后 manager.active_connections 池里没有这个 ws。"""
        import backend.server as srv
        mock_engine = MagicMock()
        mock_engine.get_state.return_value = {"base": {"position": [0, 0, 0]}}
        with patch("backend.server.engine", mock_engine):
            client = _get_client()
            with client.websocket_connect("/ws/physics_stream") as ws:
                ws.receive_text()
                connections_during = len(srv.manager.active_connections)
                self.assertGreater(connections_during, 0)
            # 退出 with → 客户端断开 → server 收到 WebSocketDisconnect
            # manager.disconnect 把它从 active_connections 移除
            self.assertEqual(
                len([c for c in srv.manager.active_connections if c is ws]),
                0,
            )


if __name__ == "__main__":
    unittest.main()

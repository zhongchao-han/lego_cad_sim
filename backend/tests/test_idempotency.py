"""
test_idempotency.py
====================
覆盖 backend/idempotency.py 的两层契约：

  - IdempotencyCache：TTL / lookup hit-miss / 同 key 不同 body 报错
  - IdempotencyMiddleware：通过 FastAPI TestClient 模拟真实重放路径
    * 不传 header → 透传，不缓存
    * 同 key 同 body → 第二次不再触达 handler，回放缓存
    * 同 key 不同 body → 409 Conflict
    * 4xx/5xx 响应 → 不缓存，下次重放仍真跑
    * GET 请求 → 中间件不参与
"""
from __future__ import annotations

import os
import sys
import unittest

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.idempotency import IdempotencyCache, IdempotencyMiddleware  # noqa: E402


class TestIdempotencyCache(unittest.TestCase):
    def test_lookup_miss_returns_none(self):
        cache = IdempotencyCache()
        self.assertIsNone(cache.lookup("k1", "h1"))

    def test_lookup_hit_returns_cached_response(self):
        cache = IdempotencyCache()
        cache.store("k1", "h1", {"ok": True})
        self.assertEqual(cache.lookup("k1", "h1"), {"ok": True})

    def test_lookup_same_key_different_body_raises(self):
        cache = IdempotencyCache()
        cache.store("k1", "h1", {"ok": True})
        with self.assertRaises(ValueError):
            cache.lookup("k1", "h-different")

    def test_ttl_expiry_evicts_entry(self):
        cache = IdempotencyCache(ttl_seconds=10.0)
        cache.store("k1", "h1", {"ok": True}, now=100.0)
        # 11 秒后该条目应已过期
        self.assertIsNone(cache.lookup("k1", "h1", now=111.0))
        # 过期清理后内部 store 也应清空
        self.assertEqual(len(cache), 0)

    def test_hash_body_deterministic_and_distinguishing(self):
        h1 = IdempotencyCache.hash_body(b"payload-A")
        h2 = IdempotencyCache.hash_body(b"payload-A")
        h3 = IdempotencyCache.hash_body(b"payload-B")
        self.assertEqual(h1, h2)
        self.assertNotEqual(h1, h3)


# ── Middleware integration tests ─────────────────────────────────────────────
class _Echo(BaseModel):
    n: int


def _build_app() -> tuple[FastAPI, IdempotencyCache, dict]:
    """构造一个最小 FastAPI app + 调用计数器，便于断言 handler 是否被真跑。"""
    cache = IdempotencyCache(ttl_seconds=60.0)
    counters = {"echo": 0, "boom": 0}

    app = FastAPI()
    app.add_middleware(IdempotencyMiddleware, cache=cache)

    @app.post("/echo")
    async def echo(payload: _Echo):  # type: ignore[unused-ignore]
        counters["echo"] += 1
        return {"received": payload.n, "calls": counters["echo"]}

    @app.post("/boom")
    async def boom():  # type: ignore[unused-ignore]
        counters["boom"] += 1
        raise HTTPException(status_code=500, detail="planned failure")

    @app.get("/peek")
    async def peek():  # type: ignore[unused-ignore]
        return {"ok": True}

    return app, cache, counters


class TestIdempotencyMiddleware(unittest.TestCase):
    def test_no_header_pass_through_no_caching(self):
        app, cache, counters = _build_app()
        client = TestClient(app)
        r1 = client.post("/echo", json={"n": 1})
        r2 = client.post("/echo", json={"n": 1})
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(counters["echo"], 2)  # 都真跑了
        self.assertEqual(len(cache), 0)
        self.assertNotIn("idempotency-replay", {k.lower() for k in r2.headers.keys()})

    def test_same_key_same_body_returns_cached(self):
        app, cache, counters = _build_app()
        client = TestClient(app)
        headers = {"Idempotency-Key": "abc-123"}

        r1 = client.post("/echo", json={"n": 7}, headers=headers)
        r2 = client.post("/echo", json={"n": 7}, headers=headers)

        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r1.json(), r2.json())
        self.assertEqual(counters["echo"], 1)  # 第二次没触达 handler
        self.assertEqual(r2.headers.get("Idempotency-Replay"), "true")

    def test_same_key_different_body_returns_409(self):
        app, _cache, counters = _build_app()
        client = TestClient(app)
        headers = {"Idempotency-Key": "abc-123"}

        r1 = client.post("/echo", json={"n": 1}, headers=headers)
        r2 = client.post("/echo", json={"n": 2}, headers=headers)

        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 409)
        self.assertEqual(counters["echo"], 1)  # 冲突时不重跑

    def test_failure_response_not_cached(self):
        app, _cache, counters = _build_app()
        client = TestClient(app)
        headers = {"Idempotency-Key": "boom-key"}

        r1 = client.post("/boom", headers=headers)
        r2 = client.post("/boom", headers=headers)

        self.assertEqual(r1.status_code, 500)
        self.assertEqual(r2.status_code, 500)
        self.assertEqual(counters["boom"], 2)  # 5xx 不缓存，第二次仍真跑

    def test_get_request_bypasses_middleware(self):
        app, cache, _counters = _build_app()
        client = TestClient(app)
        # 即使带 header，GET 也不应被缓存
        r = client.get("/peek", headers={"Idempotency-Key": "ignored"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(cache), 0)


if __name__ == "__main__":
    unittest.main()

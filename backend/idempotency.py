"""
轻量级幂等键中间件 —— 防止网络抖动 / 双击 / 客户端重试在变异端点产生幽灵副作用。

合约（详见 docs/06_engineering_standards/02_api_and_websocket_contract.md §Idempotency）：
- 客户端在 mutating POST 请求里塞 `Idempotency-Key` header（建议 UUIDv4 / RFC 4122）
- 服务端缓存 (key, body_hash) → response，TTL 内同 key 同 body 直接回放
- 同 key 不同 body → 409 Conflict（防 key 复用滥用）
- 没传 header → 直接放行不缓存（向后兼容现有不带 header 的客户端）
- 重放响应带 `Idempotency-Replay: true` header，便于客户端判定

设计取舍：
- 单机内存（threading.Lock + dict + TTL 软驱逐）。无 Redis 依赖；服务进程重启
  意味着所有 in-flight 重试场景天然失效，丢 key 可接受。
- 仅缓存 2xx 响应；4xx/5xx 不缓存（客户端常通过重试期待恢复）。
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)

DEFAULT_TTL_SECONDS = 600.0  # 10 min；交互层重试窗口绰绰有余


class IdempotencyCache:
    """线程安全 TTL 缓存。值为 (body_hash, expiry_ts, response_dict)。"""

    def __init__(self, ttl_seconds: float = DEFAULT_TTL_SECONDS):
        self._store: dict[str, tuple[str, float, dict]] = {}
        self._lock = threading.Lock()
        self.ttl = ttl_seconds

    @staticmethod
    def hash_body(body: bytes) -> str:
        return hashlib.sha256(body).hexdigest()

    def lookup(
        self,
        key: str,
        body_hash: str,
        now: Optional[float] = None,
    ) -> Optional[dict]:
        """命中且 body 一致返 cached response；命中但 body 不同抛 ValueError。"""
        ts = now if now is not None else time.time()
        with self._lock:
            self._evict_expired_locked(ts)
            entry = self._store.get(key)
            if entry is None:
                return None
            cached_hash, _, response = entry
            if cached_hash != body_hash:
                raise ValueError(
                    f"Idempotency-Key '{key}' reused with a different request body"
                )
            return response

    def store(
        self,
        key: str,
        body_hash: str,
        response: dict,
        now: Optional[float] = None,
    ) -> None:
        ts = now if now is not None else time.time()
        with self._lock:
            self._store[key] = (body_hash, ts + self.ttl, response)

    def _evict_expired_locked(self, now: float) -> None:
        expired = [k for k, (_, exp, _) in self._store.items() if exp < now]
        for k in expired:
            del self._store[k]

    def __len__(self) -> int:
        with self._lock:
            return len(self._store)


class IdempotencyMiddleware(BaseHTTPMiddleware):
    """对所有 POST 请求启用幂等键检查；client 不传 header 时透传。"""

    def __init__(self, app: ASGIApp, cache: IdempotencyCache):
        super().__init__(app)
        self.cache = cache

    async def dispatch(self, request: Request, call_next):
        if request.method != "POST":
            return await call_next(request)

        idem_key = request.headers.get("Idempotency-Key")
        if not idem_key:
            return await call_next(request)

        body = await request.body()
        body_hash = IdempotencyCache.hash_body(body)

        # 1) 命中检查
        try:
            cached = self.cache.lookup(idem_key, body_hash)
        except ValueError as exc:
            logger.warning("[Idempotency] %s", exc)
            return JSONResponse(status_code=409, content={"detail": str(exc)})

        if cached is not None:
            return JSONResponse(content=cached, headers={"Idempotency-Replay": "true"})

        # 2) middleware 已 consume body stream，重排 receive 让下游能再读一次
        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        request._receive = receive  # noqa: SLF001 — Starlette 文档许可的 body-replay 模式

        # 3) 执行下游
        response = await call_next(request)

        # 4) 仅缓存 2xx JSON 响应
        if 200 <= response.status_code < 300:
            response_body = b""
            async for chunk in response.body_iterator:
                response_body += chunk

            try:
                cached_dict = json.loads(response_body)
                if isinstance(cached_dict, dict):
                    self.cache.store(idem_key, body_hash, cached_dict)
            except (json.JSONDecodeError, UnicodeDecodeError):
                logger.debug("[Idempotency] %s: response not JSON dict, skip cache", idem_key)

            # body_iterator 已耗尽，重建 Response。Starlette 会按 content 重算
            # content-length，所以从原 headers 里去掉旧值避免冲突。
            hdrs = dict(response.headers)
            hdrs.pop("content-length", None)
            return Response(
                content=response_body,
                status_code=response.status_code,
                headers=hdrs,
                media_type=response.media_type,
            )

        return response

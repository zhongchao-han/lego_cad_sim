"""Layer 2 后端持久化：用户搭建草稿的 SQLite 存储。

本地优先架构里这是"安全位置"的兜底——前端始终先写本地（IndexedDB 双槽），
再后台把整份草稿 PUT 到这里。设备坏 / 浏览器数据被清后，可从这里拉回。

设计取舍：
 - 单表 + 整份 JSON blob。草稿是前端 zustand persist 的序列化串，后端不解析其
   内部结构（解耦：前端形状演进不需要改后端 schema）。
 - last-write-wins 以 client_ts（前端落定时间）为准：收到的 client_ts 比库里旧
   则判为陈旧写入（多标签页/离线补传乱序），拒绝覆盖，避免老草稿盖掉新草稿。
 - 每次操作开新连接 + 进程级锁串行化写，简单可靠（草稿写频率很低）。
"""

import os
import sqlite3
import threading
import time
from typing import Optional

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_DB = os.path.join(_REPO_ROOT, "data", "builds.db")

_DB_PATH = os.environ.get("BUILDS_DB_PATH", _DEFAULT_DB)
_lock = threading.Lock()
_initialized = False


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_schema() -> None:
    global _initialized
    if _initialized:
        return
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS builds (
                id         TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                client_ts  REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        conn.commit()
    _initialized = True


def put_build(build_id: str, data: str, client_ts: float) -> dict:
    """写入/更新一份草稿。client_ts 比库里旧则拒绝（陈旧写入）。"""
    if not build_id or not isinstance(data, str):
        return {"status": "error", "msg": "invalid build_id or data"}
    with _lock:
        _ensure_schema()
        now = time.time()
        with _connect() as conn:
            row = conn.execute(
                "SELECT client_ts FROM builds WHERE id = ?", (build_id,)
            ).fetchone()
            if row is not None and float(row["client_ts"]) > float(client_ts):
                return {
                    "status": "stale",
                    "msg": "incoming client_ts older than stored",
                    "stored_client_ts": float(row["client_ts"]),
                }
            conn.execute(
                """
                INSERT INTO builds (id, data, client_ts, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    data = excluded.data,
                    client_ts = excluded.client_ts,
                    updated_at = excluded.updated_at
                """,
                (build_id, data, float(client_ts), now),
            )
            conn.commit()
        return {"status": "ok", "updated_at": now}


def get_build(build_id: str) -> Optional[dict]:
    with _lock:
        _ensure_schema()
        with _connect() as conn:
            row = conn.execute(
                "SELECT id, data, client_ts, updated_at FROM builds WHERE id = ?",
                (build_id,),
            ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "data": row["data"],
        "client_ts": float(row["client_ts"]),
        "updated_at": float(row["updated_at"]),
    }


def list_builds() -> list:
    """列出全部草稿元信息（不含 data blob），按更新时间倒序。"""
    with _lock:
        _ensure_schema()
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT id, client_ts, updated_at, LENGTH(data) AS size
                FROM builds ORDER BY updated_at DESC
                """
            ).fetchall()
    return [
        {
            "id": r["id"],
            "client_ts": float(r["client_ts"]),
            "updated_at": float(r["updated_at"]),
            "size": int(r["size"]),
        }
        for r in rows
    ]

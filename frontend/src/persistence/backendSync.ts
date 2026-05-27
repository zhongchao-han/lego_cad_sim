// Layer 2：本地优先的后台同步。
//
// 原则：搭建永远先写本地（IndexedDB 双槽，Layer 0），**绝不被网络阻塞**。
// 本模块只在后台把整份草稿异步推到后端 SQLite；失败/离线就攒着 dirty 标记，
// 联网后自动补传。设备坏 / 浏览器数据被清后，可用 pullFromBackend 拉回。
//
// last-write-wins 由 client_ts（推送时刻）决定；后端拒绝陈旧写入。

import { KV_STORE, idbGet, idbSet } from './idb';
import { overwriteMain, readMain } from './safeStorage';

const API_URL = 'http://localhost:8000';
const BUILD_ID_KEY = 'sync:build-id';
const PUSH_DEBOUNCE_MS = 3000;
const RETRY_INTERVAL_MS = 30000;

let _buildId: string | null = null;
let _dirty = false;
let _pushing = false;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _retryTimer: ReturnType<typeof setInterval> | null = null;
let _lastSyncedTs = 0;

/** 取（或首次生成并持久化）本浏览器的 buildId。 */
export async function getBuildId(): Promise<string> {
  if (_buildId) return _buildId;
  try {
    const existing = await idbGet<string>(KV_STORE, BUILD_ID_KEY);
    if (existing) {
      _buildId = existing;
      return existing;
    }
  } catch {
    /* 读失败则新建 */
  }
  const id = `build_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  _buildId = id;
  try {
    await idbSet(KV_STORE, id, BUILD_ID_KEY);
  } catch {
    /* 写失败也无妨，本会话内 _buildId 仍可用 */
  }
  return id;
}

/** 把当前主工作区推到后端。本地优先：任何失败都只是保留 dirty，不抛错。 */
async function push(): Promise<void> {
  if (_pushing) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const data = await readMain();
  if (!data) {
    _dirty = false;
    return;
  }

  _pushing = true;
  const clientTs = Date.now();
  try {
    const buildId = await getBuildId();
    const res = await fetch(`${API_URL}/api/builds/${encodeURIComponent(buildId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, client_ts: clientTs }),
    });
    if (res.ok) {
      _dirty = false;
      _lastSyncedTs = clientTs;
    }
    // 非 2xx（含 stale）：保留 dirty，等下次重试或下次改动。
  } catch {
    // 网络错误/后端未起：保留 dirty，online/重试定时器会补。
  } finally {
    _pushing = false;
  }
}

/** 标记草稿已变更，安排一次 debounced 后台推送。 */
export function markDirtyAndSync(): void {
  _dirty = true;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    void push();
  }, PUSH_DEBOUNCE_MS);
}

/** 从后端拉回某份草稿（默认本浏览器 buildId），写回主槽。成功返回 true，调用方负责 reload。 */
export async function pullFromBackend(buildId?: string): Promise<boolean> {
  try {
    const id = buildId ?? (await getBuildId());
    const res = await fetch(`${API_URL}/api/builds/${encodeURIComponent(id)}`);
    if (!res.ok) return false;
    const json = (await res.json()) as { status?: string; data?: string };
    if (json.status !== 'ok' || typeof json.data !== 'string') return false;
    await overwriteMain(json.data);
    return true;
  } catch {
    return false;
  }
}

/** 列出后端已同步的全部草稿（恢复 UI 用）。失败返回空数组。 */
export async function listBackendBuilds(): Promise<
  { id: string; client_ts: number; updated_at: number; size: number }[]
> {
  try {
    const res = await fetch(`${API_URL}/api/builds`);
    if (!res.ok) return [];
    const json = (await res.json()) as { builds?: unknown[] };
    return (json.builds as never[]) ?? [];
  } catch {
    return [];
  }
}

export function getSyncState(): { dirty: boolean; lastSyncedTs: number } {
  return { dirty: _dirty, lastSyncedTs: _lastSyncedTs };
}

/** 启动后台同步：联网事件 + 周期性补传 dirty。幂等。 */
export function startBackendSync(): void {
  if (typeof window === 'undefined') return;
  if (_retryTimer) return;
  window.addEventListener('online', () => {
    if (_dirty) void push();
  });
  _retryTimer = setInterval(() => {
    if (_dirty) void push();
  }, RETRY_INTERVAL_MS);
}

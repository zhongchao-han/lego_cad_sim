// Layer 0：防损坏的本地存储适配器（实现 zustand 的 StateStorage）。
//
// 三道保护，目标是"草稿不会因为什么原因莫名消失"：
//  1. 信封 + checksum：每次写入包成 { v, ts, checksum, data }，读回先校验
//     checksum；半截/被截断的写入校验失败，直接当作该槽无效。
//  2. A/B 双槽轮换：每次写到与当前指针相反的槽，写满后再翻指针。任何时刻
//     至少有一个完好的旧槽；崩在写一半也只是损坏了"非当前"槽，指针仍指向好的。
//  3. 读失败回退：当前槽校验失败时自动回退另一槽；两槽都坏才返回 null，
//     且【绝不删除损坏数据】——保留原始 blob 供人工/后端恢复，杜绝"解析失败即清空"。
//
// 另：写入 debounce 合并高频改动，pagehide/visibilitychange 时强制 flush，
// 避免最后一笔改动还没落盘就关页。IndexedDB 不可用（隐私模式等）时回退内存，
// 保证 app 不崩（此时仅本会话不持久，靠 Layer 2 后端兜底）。

import debounce from 'lodash.debounce';
import { KV_STORE, idbDel, idbGet, idbSet } from './idb';

/** 持久化信封 schema 版本。改变持久化形状时 +1（供未来迁移判断）。 */
export const SCHEMA_VERSION = 1;

/** zustand persist 的 store name —— 主工作区槽的命名空间。 */
export const STORE_NAME = 'lego-cad-assembly-storage';

export interface Envelope {
  v: number;
  ts: number;
  checksum: number;
  data: string;
}

/** cyrb53 —— 快速非加密 hash，仅用于完整性校验（检测截断/损坏，非防篡改）。 */
export function checksum(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function wrap(data: string): Envelope {
  return { v: SCHEMA_VERSION, ts: Date.now(), checksum: checksum(data), data };
}

/** 校验并取出信封里的 data；损坏（checksum 不符 / 结构非法）返回 null。 */
export function unwrap(env: unknown): string | null {
  if (!env || typeof env !== 'object') return null;
  const e = env as Partial<Envelope>;
  if (typeof e.data !== 'string' || typeof e.checksum !== 'number') return null;
  if (checksum(e.data) !== e.checksum) return null;
  return e.data;
}

const slotKeys = (name: string) => ({
  A: `${name}:slotA`,
  B: `${name}:slotB`,
  ptr: `${name}:pointer`,
});

// IndexedDB 不可用时的内存回退。
const _memFallback = new Map<string, unknown>();
let _idbBroken = false;

async function kvGet<T>(key: string): Promise<T | undefined> {
  if (_idbBroken) return _memFallback.get(key) as T | undefined;
  try {
    return await idbGet<T>(KV_STORE, key);
  } catch {
    _idbBroken = true;
    return _memFallback.get(key) as T | undefined;
  }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  if (_idbBroken) {
    _memFallback.set(key, value);
    return;
  }
  try {
    await idbSet(KV_STORE, value, key);
  } catch {
    _idbBroken = true;
    _memFallback.set(key, value);
  }
}

async function kvDel(key: string): Promise<void> {
  _memFallback.delete(key);
  if (_idbBroken) return;
  try {
    await idbDel(KV_STORE, key);
  } catch {
    _idbBroken = true;
  }
}

/** 真正的落盘逻辑（双槽轮换）。被 debounce 包裹。 */
async function commit(name: string, value: string): Promise<void> {
  const keys = slotKeys(name);
  const ptr = (await kvGet<'A' | 'B'>(keys.ptr)) ?? 'B';
  const target = ptr === 'A' ? 'B' : 'A'; // 写到非当前槽
  await kvSet(keys[target], wrap(value));
  // 仅在新槽完整写入后才翻指针——崩在上一步只损坏了非当前槽。
  await kvSet(keys.ptr, target);
}

// 每个 store name 各自维护待写值 + debounced flush。
const _pending = new Map<string, string>();
const _debounced = new Map<string, ReturnType<typeof debounce>>();

function getDebounced(name: string) {
  let d = _debounced.get(name);
  if (!d) {
    d = debounce(() => void flushOne(name), 800);
    _debounced.set(name, d);
  }
  return d;
}

/** 提交某 name 的待写值并清空 _pending（提交后若值未被新改动覆盖才清）。
 *  清空避免后续 pagehide 反复重写同一份数据；新 setItem 会重新写入 _pending。 */
async function flushOne(name: string): Promise<void> {
  const v = _pending.get(name);
  if (v === undefined) return;
  await commit(name, v);
  if (_pending.get(name) === v) _pending.delete(name);
}

/** 立即落盘所有待写改动（pagehide / 手动调用 / 测试）。返回 Promise 便于等待落盘。
 *  注意：unload 期间 IndexedDB 异步事务不保证一定完成，故 pagehide flush 属尽力而为；
 *  真正的"绝不丢"靠双槽里 ≤debounce 间隔前的完好旧值 + 自动快照 + 后端同步兜底。 */
export function flushSafeStorage(): Promise<void> {
  const writes: Promise<void>[] = [];
  for (const [name, d] of _debounced) {
    d.cancel();
    writes.push(flushOne(name));
  }
  return Promise.all(writes).then(() => undefined);
}

if (typeof window !== 'undefined') {
  // pagehide 比 beforeunload 在移动端/bfcache 下更可靠；两者都挂。
  window.addEventListener('pagehide', flushSafeStorage);
  window.addEventListener('beforeunload', flushSafeStorage);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSafeStorage();
  });
}

/** 读主工作区当前已落盘的值（供 Layer 1 快照拷贝 / Layer 2 同步读取）。 */
export function readMain(): Promise<string | null> {
  return safeStorage.getItem(STORE_NAME);
}

/** 把一段数据整体写入主工作区两槽（供快照/后端恢复用）。写完两槽再翻指针。 */
export async function overwriteMain(data: string): Promise<void> {
  const keys = slotKeys(STORE_NAME);
  _pending.delete(STORE_NAME);
  _debounced.get(STORE_NAME)?.cancel();
  await kvSet(keys.A, wrap(data));
  await kvSet(keys.B, wrap(data));
  await kvSet(keys.ptr, 'A');
}

/** zustand persist 用的 StateStorage 实现（异步）。 */
export const safeStorage = {
  async getItem(name: string): Promise<string | null> {
    const keys = slotKeys(name);
    const ptr = (await kvGet<'A' | 'B'>(keys.ptr)) ?? 'B';
    const order: ('A' | 'B')[] = ptr === 'A' ? ['A', 'B'] : ['B', 'A'];
    for (const slot of order) {
      const env = await kvGet<Envelope>(keys[slot]);
      const data = unwrap(env);
      if (data !== null) return data;
    }
    // 两槽皆空：一次性迁移旧版 localStorage 草稿（升级前用 localStorage 存的用户）。
    // 直接返回旧值的原始串，persist 解析后会在下次改动落进 IndexedDB，完成迁移。
    // 不删除 localStorage 原值（留作回退）。损坏的 IDB 槽同样不删（留待恢复）。
    try {
      const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null;
      if (legacy) return legacy;
    } catch {
      /* localStorage 不可用则忽略 */
    }
    return null;
  },

  setItem(name: string, value: string): void {
    _pending.set(name, value);
    getDebounced(name)();
  },

  async removeItem(name: string): Promise<void> {
    const keys = slotKeys(name);
    _pending.delete(name);
    _debounced.get(name)?.cancel();
    await kvDel(keys.A);
    await kvDel(keys.B);
    await kvDel(keys.ptr);
  },
};

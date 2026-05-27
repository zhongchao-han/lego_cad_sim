/**
 * storePersistShape.test.ts
 * =========================
 * 持久化白名单契约（issue #64 #4）。守护两条不变量：
 *
 *   1. zustand persist 落盘 key 集合 == PERSISTED_FIELD_KEYS 声明
 *   2. transient state 字段 reload 后不会被恢复（避免静默持久）
 *
 * 编译期已经把"漏分类字段"挡住（store.ts _ExhaustiveStateClassification）。
 * 这里补运行时回归 — partialize 实现意外漏字段 / 多字段时翻红。
 *
 * 存储后端已从 localStorage 换成防损坏 IndexedDB 双槽（persistence/safeStorage）。
 * 本测试只关心 partialize 序列化形状，与具体存储无关——故 spy 在 safeStorage.setItem
 * 上，直接读 persist 交给 storage 的那串 JSON（即过去写进 localStorage 的同一内容）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, __persistFieldsForTest } from '../store';
import { safeStorage } from '../persistence/safeStorage';

describe('store persist shape — issue #64 #4 partialize 白名单', () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setItemSpy = vi.spyOn(safeStorage, 'setItem');
  });
  afterEach(() => {
    setItemSpy.mockRestore();
  });

  /** 取 persist 最近一次交给 storage 的序列化 state（{state, version} 里的 state）。 */
  function lastPersistedState(): Record<string, unknown> {
    const calls = setItemSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const payload = calls[calls.length - 1][1] as string;
    return (JSON.parse(payload) as { state: Record<string, unknown> }).state;
  }

  it('case 1: __persistFieldsForTest 是稳定 readonly 数组', () => {
    expect(__persistFieldsForTest).toEqual([
      'parts',
      'connections',
      'occupiedPorts',
      'activeColorCode',
      'cameraTarget',
      'partUsages',
      'hiddenParts',
    ]);
  });

  it('case 2: 当前 store state 能被 reset 不抛错', () => {
    expect(useStore.getState().parts).toBeDefined();
    expect(useStore.getState().connections).toBeDefined();
  });

  it('case 3: 落盘的字段 key 集合 == 白名单', () => {
    useStore.setState({ activeColorCode: 14 });
    const persistedKeys = Object.keys(lastPersistedState()).sort();
    expect(persistedKeys).toEqual([...__persistFieldsForTest].sort());
  });

  it('case 4: transient 字段 isSearchOpen 不会被持久化', () => {
    useStore.setState({ isSearchOpen: true });
    expect(lastPersistedState()).not.toHaveProperty('isSearchOpen');
  });

  it('case 5: transient 字段 logs / interactionPhase / view 不会被持久化', () => {
    useStore.setState({ activeColorCode: 7 });
    const state = lastPersistedState();
    for (const key of ['logs', 'interactionPhase', 'view', 'mode', 'isContextLost']) {
      expect(state, `transient ${key} 不应出现在持久化对象`).not.toHaveProperty(key);
    }
  });

  it('case 6: connections 持久化为 Array 形式（Set 不能 JSON 化）', () => {
    useStore.setState({
      connections: {
        nodeA: new Set(['nodeB', 'nodeC']),
      },
    });
    const state = lastPersistedState() as { connections: Record<string, unknown> };
    expect(Array.isArray(state.connections.nodeA)).toBe(true);
    expect(state.connections.nodeA).toEqual(['nodeB', 'nodeC']);
  });

  it('case 7: hiddenParts 持久化为 Array 形式', () => {
    useStore.setState({ hiddenParts: new Set(['p1', 'p2']) });
    const state = lastPersistedState() as { hiddenParts: unknown };
    expect(Array.isArray(state.hiddenParts)).toBe(true);
    expect(state.hiddenParts).toEqual(['p1', 'p2']);
  });
});

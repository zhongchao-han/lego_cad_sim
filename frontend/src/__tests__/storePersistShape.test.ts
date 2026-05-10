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
 */

import { describe, it, expect } from 'vitest';
import { useStore, __persistFieldsForTest } from '../store';

describe('store persist shape — issue #64 #4 partialize 白名单', () => {
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
    // 仅冒烟 — 确保 store 初始化路径正常（persist + merge + onRehydrateStorage
    // 不 trip）。
    expect(useStore.getState().parts).toBeDefined();
    expect(useStore.getState().connections).toBeDefined();
  });

  it('case 3: localStorage 落盘的字段 key 集合 == 白名单', () => {
    // 触发一次 persist 写盘（zustand persist 默认每次 setState 写）
    useStore.setState({ activeColorCode: 14 });
    const raw = window.localStorage.getItem('lego-cad-assembly-storage');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    const persistedKeys = Object.keys(parsed.state).sort();
    expect(persistedKeys).toEqual([...__persistFieldsForTest].sort());
  });

  it('case 4: transient 字段 isSearchOpen 不会被持久化', () => {
    useStore.setState({ isSearchOpen: true });
    const raw = window.localStorage.getItem('lego-cad-assembly-storage');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(parsed.state).not.toHaveProperty('isSearchOpen');
  });

  it('case 5: transient 字段 logs / interactionPhase / view 不会被持久化', () => {
    const raw = window.localStorage.getItem('lego-cad-assembly-storage');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    for (const key of ['logs', 'interactionPhase', 'view', 'mode', 'isContextLost']) {
      expect(parsed.state, `transient ${key} 不应出现在持久化对象`).not.toHaveProperty(key);
    }
  });

  it('case 6: connections 持久化为 Array 形式（Set 不能 JSON 化）', () => {
    useStore.setState({
      connections: {
        nodeA: new Set(['nodeB', 'nodeC']),
      },
    });
    const raw = window.localStorage.getItem('lego-cad-assembly-storage');
    const parsed = JSON.parse(raw!) as { state: { connections: Record<string, unknown> } };
    // 序列化后是 Array 而非 Set / Object
    expect(Array.isArray(parsed.state.connections.nodeA)).toBe(true);
    expect(parsed.state.connections.nodeA).toEqual(['nodeB', 'nodeC']);
  });

  it('case 7: hiddenParts 持久化为 Array 形式', () => {
    useStore.setState({ hiddenParts: new Set(['p1', 'p2']) });
    const raw = window.localStorage.getItem('lego-cad-assembly-storage');
    const parsed = JSON.parse(raw!) as { state: { hiddenParts: unknown } };
    expect(Array.isArray(parsed.state.hiddenParts)).toBe(true);
    expect(parsed.state.hiddenParts).toEqual(['p1', 'p2']);
  });
});

/**
 * portSelectionLevel.test.ts
 * ==========================
 * B.2 — port 选择模式（PORT / PLUG）的 store 行为契约。
 *
 * 覆盖：
 *   - 初始 INDIVIDUAL
 *   - setPortSelectionLevel(PLUG) 生效
 *   - abortCurrentInteraction 复位 INDIVIDUAL
 *   - deselectAll 复位 INDIVIDUAL
 *   - 持久化白名单不含 portSelectionLevel（reload 应回 INDIVIDUAL）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, __persistFieldsForTest } from '../store';
import { SelectionLevel, InteractionPhase, ZoneType } from '../types';

function resetStore() {
  useStore.setState({
    parts: {},
    connections: {},
    occupiedPorts: {},
    selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
    selectedPort: null,
    hoveredPort: null,
    slidingTarget: null,
    slideOffset: 0,
    interactionPhase: InteractionPhase.IDLE,
    portSelectionLevel: SelectionLevel.INDIVIDUAL,
    snapPreState: null,
    continuousPlacementSource: null,
  } as any);
}

describe('store.portSelectionLevel — B.2 port 选择模式契约', () => {
  beforeEach(() => resetStore());

  it('case 1: 初始 INDIVIDUAL', () => {
    expect(useStore.getState().portSelectionLevel).toBe(SelectionLevel.INDIVIDUAL);
  });

  it('case 2: setPortSelectionLevel(PLUG) → store 切换', () => {
    useStore.getState().setPortSelectionLevel(SelectionLevel.PLUG);
    expect(useStore.getState().portSelectionLevel).toBe(SelectionLevel.PLUG);
  });

  it('case 3: abortCurrentInteraction → 复位 INDIVIDUAL', () => {
    useStore.setState({
      portSelectionLevel: SelectionLevel.PLUG,
      // abortCurrentInteraction 需要某些 phase 上下文，喂个无 snapPreState 的 IDLE 即可
    } as any);
    useStore.getState().abortCurrentInteraction();
    expect(useStore.getState().portSelectionLevel).toBe(SelectionLevel.INDIVIDUAL);
  });

  it('case 4: deselectAll → 复位 INDIVIDUAL', () => {
    useStore.setState({ portSelectionLevel: SelectionLevel.PLUG } as any);
    useStore.getState().deselectAll();
    expect(useStore.getState().portSelectionLevel).toBe(SelectionLevel.INDIVIDUAL);
  });

  it('case 5: portSelectionLevel 不进持久化白名单（transient — reload 回默认）', () => {
    expect(__persistFieldsForTest).not.toContain('portSelectionLevel' as never);
    // 同时验：触发一次写盘后 localStorage 不出现该字段
    useStore.getState().setPortSelectionLevel(SelectionLevel.PLUG);
    useStore.setState({ portSelectionLevel: SelectionLevel.PLUG } as any);  // 触发 partialize
    const raw = window.localStorage.getItem('lego-cad-assembly-storage');
    if (raw) {
      const parsed = JSON.parse(raw) as { state: Record<string, unknown> };
      expect(parsed.state).not.toHaveProperty('portSelectionLevel');
    }
  });

  it('case 6: SelectionLevel.PLUG 跟 part-level selection.level 互不影响', () => {
    // selection.level 仍可独立设 GROUP / INDIVIDUAL 表达 part 级粒度
    useStore.setState({
      portSelectionLevel: SelectionLevel.PLUG,
      selection: { primaryId: 'A', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['A'], excludedIds: [] },
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
    } as any);
    expect(useStore.getState().portSelectionLevel).toBe(SelectionLevel.PLUG);
    expect(useStore.getState().selection.level).toBe(SelectionLevel.INDIVIDUAL);
  });
});

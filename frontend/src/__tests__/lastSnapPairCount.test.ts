/**
 * lastSnapPairCount.test.ts
 * =========================
 * B.3-3 — snap UX 反馈字段 lastSnapPairCount 的 store 契约。
 *
 * 覆盖：
 *   - 初始 0
 *   - abortCurrentInteraction 复位 0
 *   - deselectAll 复位 0
 *   - 进 partialize TRANSIENT 白名单（reload 回 0，不持久化"上一次 snap"
 *     这种瞬时状态）
 *
 * snapParts 完整流程涉及后端 axios，集成测试见 cross-validation；本文件
 * 仅守 store 字段契约。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, __persistFieldsForTest } from '../store';
import { SelectionLevel, InteractionPhase } from '../types';

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
    lastSnapPairCount: 0,
    snapPreState: null,
    continuousPlacementSource: null,
  } as any);
}

describe('store.lastSnapPairCount — B.3-3 snap UX 反馈契约', () => {
  beforeEach(() => resetStore());

  it('case 1: 初始 0', () => {
    expect(useStore.getState().lastSnapPairCount).toBe(0);
  });

  it('case 2: 手动 set 生效（snapParts 路径用 set）', () => {
    useStore.setState({ lastSnapPairCount: 8 } as any);
    expect(useStore.getState().lastSnapPairCount).toBe(8);
  });

  it('case 3: abortCurrentInteraction → 复位 0', () => {
    useStore.setState({ lastSnapPairCount: 8 } as any);
    useStore.getState().abortCurrentInteraction();
    expect(useStore.getState().lastSnapPairCount).toBe(0);
  });

  it('case 4: deselectAll → 复位 0', () => {
    useStore.setState({ lastSnapPairCount: 5 } as any);
    useStore.getState().deselectAll();
    expect(useStore.getState().lastSnapPairCount).toBe(0);
  });

  it('case 5: 不进持久化白名单（瞬时状态 reload 回默认）', () => {
    expect(__persistFieldsForTest).not.toContain('lastSnapPairCount' as never);
    useStore.setState({ lastSnapPairCount: 10 } as any);
    const raw = window.localStorage.getItem('lego-cad-assembly-storage');
    if (raw) {
      const parsed = JSON.parse(raw) as { state: Record<string, unknown> };
      expect(parsed.state).not.toHaveProperty('lastSnapPairCount');
    }
  });

  // ─── B.3-extension：predictedSnapPairCount 同款契约 ─────────────────────
  it('case 6: predictedSnapPairCount 初始 null', () => {
    expect(useStore.getState().predictedSnapPairCount).toBeNull();
  });

  it('case 7: abortCurrentInteraction → predictedSnapPairCount 复位 null', () => {
    useStore.setState({ predictedSnapPairCount: 8 } as any);
    useStore.getState().abortCurrentInteraction();
    expect(useStore.getState().predictedSnapPairCount).toBeNull();
  });

  it('case 8: deselectAll → predictedSnapPairCount 复位 null', () => {
    useStore.setState({ predictedSnapPairCount: 4 } as any);
    useStore.getState().deselectAll();
    expect(useStore.getState().predictedSnapPairCount).toBeNull();
  });

  it('case 9: predictedSnapPairCount 不进持久化白名单', () => {
    expect(__persistFieldsForTest).not.toContain('predictedSnapPairCount' as never);
  });
});

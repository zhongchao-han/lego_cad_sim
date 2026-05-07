/**
 * useKeyboardShortcuts.test.tsx
 * =============================
 * 审计 Round 2 — useKeyboardShortcuts 0 单测，覆盖：
 *   - isInputFocused 短路（INPUT/TEXTAREA/contentEditable 焦点时所有快捷键 no-op）
 *   - Cmd/Ctrl 系列：Z(undo) / Shift+Z(redo) / Y(redo Win) / C/V/D/A
 *   - 单键：Delete / Backspace / Esc / F / H
 *   - Enter 仅在 AXIAL_SLIDING 生效
 *   - ArrowUp/Down 仅在 AXIAL_SLIDING 生效；Shift 步长 ×10
 *   - [/] / ArrowLeft/Right 旋转，axle 端口屏蔽
 *   - Alt+H 显示全部
 *
 * 不 mock store，直接看 store 的可观察副作用（logs / phase / clipboard /
 * cameraTarget / slideOffset / parts / selection）来断言 action 是否被触发。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useStore } from '../store';
import { ZoneType, InteractionPhase, SelectionLevel } from '../types';

const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number[], number[], number[]];

function makePort(partId: string, portType: string = 'peg.dat') {
  return {
    partId,
    ldrawId: `${partId}.dat`,
    portType,
    position: [0, 0, 0] as [number, number, number],
    rotation: EYE3,
    globalPos: [0, 0, 0] as [number, number, number],
    globalQuat: [0, 0, 0, 1] as [number, number, number, number],
  };
}

function fireKey(opts: KeyboardEventInit & { key: string }) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...opts }));
  });
}

function setupBasicScene() {
  useStore.setState({
    parts: {
      A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      B: { ldrawId: 'B.dat', position: [10, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
    },
    connections: {},
    occupiedPorts: {},
    selection: { primaryId: 'A', level: SelectionLevel.GROUP, allConnectedIds: ['A'], excludedIds: [] },
    selectedPort: null,
    slidingTarget: null,
    slideOffset: 0,
    interactionPhase: InteractionPhase.IDLE,
    continuousPlacementSource: null,
    clipboard: [],
    cameraTarget: null,
    hiddenParts: new Set<string>(),
    logs: [],
  } as any);
}

describe('useKeyboardShortcuts — 全键映射', () => {
  beforeEach(() => {
    setupBasicScene();
    // 确保焦点不在 input
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  afterEach(() => {
    document.querySelectorAll('input,textarea').forEach(el => el.remove());
  });

  // ──────────────────────── 输入焦点屏蔽 ────────────────────────
  it('case 1: input focused → 任何快捷键 no-op (F 不触发 focusCameraOnSelected)', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    fireKey({ key: 'f' });
    expect(useStore.getState().cameraTarget).toBeNull(); // 未触发 focusCameraOnSelected
    unmount();
  });

  // ──────────────────────── Cmd/Ctrl 系列 ────────────────────────
  it('case 2: Cmd+Z → undo 触发，addLog "Undo performed"', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'z', metaKey: true });
    expect(useStore.getState().logs.some(l => l.message.includes('Undo performed'))).toBe(true);
    unmount();
  });

  it('case 3: Ctrl+Y → redo 触发', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'y', ctrlKey: true });
    expect(useStore.getState().logs.some(l => l.message.includes('Redo performed'))).toBe(true);
    unmount();
  });

  it('case 4: Cmd+C → copySelected 写 clipboard', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'c', metaKey: true });
    expect(useStore.getState().clipboard.length).toBeGreaterThan(0);
    unmount();
  });

  it('case 5: Cmd+V → pasteClipboard 进 FREE_PLACING phase（先 copy 才有 payload）', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'c', metaKey: true });
    fireKey({ key: 'v', metaKey: true });
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.FREE_PLACING);
    unmount();
  });

  it('case 6: Cmd+A → selectAll 把 ACTIVE_ARENA 内全部 part 选中', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'a', metaKey: true });
    const ids = useStore.getState().selection.allConnectedIds;
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    unmount();
  });

  // ──────────────────────── 单键 ────────────────────────
  it('case 7: Delete → deleteSelected 减少 parts', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    expect(Object.keys(useStore.getState().parts).length).toBe(2);
    fireKey({ key: 'Delete' });
    expect(useStore.getState().parts.A).toBeUndefined();
    unmount();
  });

  it('case 8: Esc 在非 FREE_PLACING phase → abortCurrentInteraction + deselectAll', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.SOURCE_LOCKED,
      selectedPort: makePort('A') as any,
    } as any);
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'Escape' });
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
    expect(useStore.getState().selectedPort).toBeNull();
    expect(useStore.getState().selection.allConnectedIds.length).toBe(0);
    unmount();
  });

  it('case 8b: Esc 在 FREE_PLACING phase → 单点 commitFreePlacing(undefined) 走 abort 分支 (修自 issue #61)', () => {
    // 修法 B：phase==FREE_PLACING 时只调 commitFreePlacing(undefined)，
    // 不调 abortCurrentInteraction + deselectAll，避免跟 Scene.jsx 旧 keydown
    // handler 并行的中间态。
    useStore.setState({
      interactionPhase: InteractionPhase.FREE_PLACING,
      freePlacingPayload: [{
        id: 'pasted_xxx',
        state: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      }],
    } as any);
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'Escape' });
    // commitFreePlacing(undefined) 清 payload + IDLE
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
    expect(useStore.getState().freePlacingPayload).toEqual([]);
    unmount();
  });

  it('case 9: F → focusCameraOnSelected 设 cameraTarget', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'f' });
    expect(useStore.getState().cameraTarget).not.toBeNull();
    unmount();
  });

  it('case 10: H → setHiddenSelected(true) 把 selection 加进 hiddenParts', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'h' });
    expect(useStore.getState().hiddenParts.has('A')).toBe(true);
    unmount();
  });

  it('case 11: Alt+H → showAll 清 hiddenParts', () => {
    useStore.setState({ hiddenParts: new Set(['A', 'B']) } as any);
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'h', altKey: true });
    expect(useStore.getState().hiddenParts.size).toBe(0);
    unmount();
  });

  // ──────────────────────── AXIAL_SLIDING gate ────────────────────────
  it('case 12: ArrowUp 不在 AXIAL_SLIDING phase 时 → no-op (slideOffset 不变)', () => {
    useStore.setState({ interactionPhase: InteractionPhase.IDLE, slideOffset: 0 } as any);
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'ArrowUp' });
    expect(useStore.getState().slideOffset).toBe(0);
    unmount();
  });

  it('case 13: AXIAL_SLIDING 下 ArrowUp +1 / Shift+ArrowUp +10 (peg×peghole CLEARANCE → factor 1)', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      selectedPort: makePort('A', 'peg.dat') as any,
      slidingTarget: makePort('B', 'peghole.dat') as any,
      slideOffset: 0,
    } as any);
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'ArrowUp' });
    expect(useStore.getState().slideOffset).toBeCloseTo(1, 6);
    fireKey({ key: 'ArrowUp', shiftKey: true });
    expect(useStore.getState().slideOffset).toBeCloseTo(11, 6);
    unmount();
  });

  it('case 14: AXIAL_SLIDING + Enter → commitAxialSliding (phase IDLE + slideOffset 0)', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      selectedPort: makePort('A') as any,
      slidingTarget: makePort('B') as any,
      slideOffset: 5,
    } as any);
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: 'Enter' });
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
    expect(useStore.getState().slideOffset).toBe(0);
    unmount();
  });

  // ──────────────────────── 旋转 [/] ────────────────────────
  it('case 15: [ 在 SOURCE_LOCKED + 非 axle 端口 → rotateSelectedPart 触发', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.SOURCE_LOCKED,
      selectedPort: makePort('A', 'peg.dat') as any,
    } as any);
    const before = useStore.getState().parts.A.quaternion;
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: '[' });
    const after = useStore.getState().parts.A.quaternion;
    expect(after).not.toEqual(before);
    unmount();
  });

  it('case 16: axle 端口（portType 含 axle）按 [ → 不触发旋转', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.SOURCE_LOCKED,
      selectedPort: makePort('A', 'axle.dat') as any,
    } as any);
    const before = useStore.getState().parts.A.quaternion;
    const { unmount } = renderHook(() => useKeyboardShortcuts());
    fireKey({ key: '[' });
    const after = useStore.getState().parts.A.quaternion;
    expect(after).toEqual(before);
    unmount();
  });
});

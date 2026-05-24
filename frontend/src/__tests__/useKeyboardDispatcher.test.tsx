/**
 * useKeyboardDispatcher.test.tsx
 * ==============================
 * 单 keydown dispatcher（issue #64 #1）单测，覆盖：
 *   - isInputFocused 短路（INPUT/TEXTAREA/contentEditable 焦点时所有快捷键 no-op）
 *   - Cmd/Ctrl 系列：Z(undo) / Shift+Z(redo) / Y(redo Win) / C/V/D/A / K(开搜索)
 *   - 单键：Delete / Backspace / Esc / F / H
 *   - Esc 路由优先级：搜索开 → 仅关搜索；FREE_PLACING → commit；其他 → abort+deselect
 *   - Enter 仅在 AXIAL_SLIDING 生效
 *   - ArrowUp/Down 仅在 AXIAL_SLIDING 生效；Shift 步长 ×10
 *   - [/] / ArrowLeft/Right 旋转，axle 端口屏蔽
 *   - Alt+H 显示全部
 *
 * 不 mock store，直接看 store 的可观察副作用（logs / phase / clipboard /
 * cameraTarget / slideOffset / parts / selection / isSearchOpen）来断言
 * action 是否被触发。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardDispatcher } from '../hooks/useKeyboardDispatcher';
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
    isSearchOpen: false,
  } as any);
}

describe('useKeyboardDispatcher — 全键映射', () => {
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
    const { unmount } = renderHook(() => useKeyboardDispatcher());
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
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'z', metaKey: true });
    expect(useStore.getState().logs.some(l => l.message.includes('Undo performed'))).toBe(true);
    unmount();
  });

  it('case 3: Ctrl+Y → redo 触发', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'y', ctrlKey: true });
    expect(useStore.getState().logs.some(l => l.message.includes('Redo performed'))).toBe(true);
    unmount();
  });

  it('case 4: Cmd+C → copySelected 写 clipboard', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'c', metaKey: true });
    expect(useStore.getState().clipboard.length).toBeGreaterThan(0);
    unmount();
  });

  it('case 5: Cmd+V → pasteClipboard 进 FREE_PLACING phase（先 copy 才有 payload）', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'c', metaKey: true });
    fireKey({ key: 'v', metaKey: true });
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.FREE_PLACING);
    unmount();
  });

  it('case 6: Cmd+A → selectAll 把 ACTIVE_ARENA 内全部 part 选中', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'a', metaKey: true });
    const ids = useStore.getState().selection.allConnectedIds;
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    unmount();
  });

  // ──────────────────────── 单键 ────────────────────────
  it('case 7: Delete → deleteSelected 减少 parts', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
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
    const { unmount } = renderHook(() => useKeyboardDispatcher());
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
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'Escape' });
    // commitFreePlacing(undefined) 清 payload + IDLE
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
    expect(useStore.getState().freePlacingPayload).toEqual([]);
    unmount();
  });

  it('case 9: F → focusCameraOnSelected 设 cameraTarget', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'f' });
    expect(useStore.getState().cameraTarget).not.toBeNull();
    unmount();
  });

  it('case 10: H → setHiddenSelected(true) 把 selection 加进 hiddenParts', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'h' });
    expect(useStore.getState().hiddenParts.has('A')).toBe(true);
    unmount();
  });

  it('case 11: Alt+H → showAll 清 hiddenParts', () => {
    useStore.setState({ hiddenParts: new Set(['A', 'B']) } as any);
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'h', altKey: true });
    expect(useStore.getState().hiddenParts.size).toBe(0);
    unmount();
  });

  // ──────────────────────── AXIAL_SLIDING gate ────────────────────────
  it('case 12: ArrowUp 不在 AXIAL_SLIDING phase 时 → no-op (slideOffset 不变)', () => {
    useStore.setState({ interactionPhase: InteractionPhase.IDLE, slideOffset: 0 } as any);
    const { unmount } = renderHook(() => useKeyboardDispatcher());
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
    const { unmount } = renderHook(() => useKeyboardDispatcher());
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
    const { unmount } = renderHook(() => useKeyboardDispatcher());
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
    const { unmount } = renderHook(() => useKeyboardDispatcher());
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
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: '[' });
    const after = useStore.getState().parts.A.quaternion;
    expect(after).toEqual(before);
    unmount();
  });
});

// ──────────────────────── issue #64 #1 单 dispatcher 路由 ──────────────────────
describe('useKeyboardDispatcher — 搜索面板 + Esc 路由（issue #64 #1）', () => {
  beforeEach(() => {
    setupBasicScene();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  it('case 17: Cmd+K → setSearchOpen(true)', () => {
    expect(useStore.getState().isSearchOpen).toBe(false);
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'k', metaKey: true });
    expect(useStore.getState().isSearchOpen).toBe(true);
    unmount();
  });

  it('case 18: Ctrl+K → setSearchOpen(true)（Windows 路径）', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'k', ctrlKey: true });
    expect(useStore.getState().isSearchOpen).toBe(true);
    unmount();
  });

  it('case 19: 搜索开 + Esc → 仅关搜索面板，不动 phase / selection', () => {
    useStore.setState({
      isSearchOpen: true,
      interactionPhase: InteractionPhase.SOURCE_LOCKED,
    } as any);
    const beforePhase = useStore.getState().interactionPhase;
    const beforeSelection = useStore.getState().selection;
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'Escape' });
    // 仅关搜索；phase / selection 全保留
    expect(useStore.getState().isSearchOpen).toBe(false);
    expect(useStore.getState().interactionPhase).toBe(beforePhase);
    expect(useStore.getState().selection).toEqual(beforeSelection);
    unmount();
  });

  it('case 20: 搜索关 + Esc + IDLE → deselectAll（不动 phase）', () => {
    useStore.setState({
      isSearchOpen: false,
      interactionPhase: InteractionPhase.IDLE,
      selection: { primaryId: 'A', level: SelectionLevel.GROUP, allConnectedIds: ['A'], excludedIds: [] },
    } as any);
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'Escape' });
    expect(useStore.getState().selection.primaryId).toBeNull();
    unmount();
  });

  it('case 21: 搜索关 + Esc + FREE_PLACING → commitFreePlacing(undefined) 走 phase 路由', () => {
    // 模拟进入 FREE_PLACING 状态。commitFreePlacing 早返条件是
    // freePlacingPayload 空，所以塞一条 stub payload 让它走完 abort 分支。
    useStore.setState({
      isSearchOpen: false,
      interactionPhase: InteractionPhase.FREE_PLACING,
      freePlacingPayload: [{ partId: 'X', ldrawId: 'X.dat' } as any],
    } as any);
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'Escape' });
    // commitFreePlacing(undefined) 走 abort 分支：清 payload + phase 回 IDLE
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
    expect(useStore.getState().freePlacingPayload).toEqual([]);
    unmount();
  });

  it('case 22: input focused + Cmd+K → 不开搜索（焦点优先级最高）', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'k', metaKey: true });
    expect(useStore.getState().isSearchOpen).toBe(false);
    unmount();
  });

  it('case 23: 搜索关 + Cmd+K 后 Esc → 开 → 关，往复（路由稳定）', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    expect(useStore.getState().isSearchOpen).toBe(false);
    fireKey({ key: 'k', metaKey: true });
    expect(useStore.getState().isSearchOpen).toBe(true);
    fireKey({ key: 'Escape' });
    expect(useStore.getState().isSearchOpen).toBe(false);
    fireKey({ key: 'k', metaKey: true });
    expect(useStore.getState().isSearchOpen).toBe(true);
    unmount();
  });

  it('case 24a: Esc + 搜索开 + 搜索框 input 已 focus → 仍关搜索（CI C7 修：Esc 路由必须先于 input-focus 守卫）', () => {
    // 模拟真实场景：PartSearchDialog mount 后 50ms 自动 focus 自己的 input。
    // 用户按 Esc 时焦点几乎一定在 search input 里。如果 input-focus 短路
    // 早于 Esc 处理，搜索就关不掉 → C7-EscCompound 在 CI 慢机器上反复翻红。
    useStore.setState({ isSearchOpen: true } as any);
    const searchInput = document.createElement('input');
    document.body.appendChild(searchInput);
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    const { unmount } = renderHook(() => useKeyboardDispatcher());
    fireKey({ key: 'Escape' });

    expect(useStore.getState().isSearchOpen).toBe(false);
    unmount();
  });

  it('case 24: Cmd+K → Esc 同帧内连发 → 搜索关闭（不依赖 useEffect re-bind 时序）', () => {
    // C7 e2e 翻红的真正起因：handler 闭包里 isSearchOpen 是上一次 render
    // 时的快照。Cmd+K → setSearchOpen(true) → 还没等到 useEffect 重绑
    // handler，紧接着的 Esc 仍走旧 closure → isSearchOpen=false → 落 phase
    // 路由分支 → 搜索没关。修后 handler 用 useStore.getState() 实时读，
    // 同帧两连击稳定。
    const { unmount } = renderHook(() => useKeyboardDispatcher());

    // 在 act() 同步触发 Cmd+K + Esc，模拟 React 还没 commit 下一帧的窗口
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(useStore.getState().isSearchOpen).toBe(false);
    // 同时验证：phase 路由分支没被误触发（selection 应保留）
    expect(useStore.getState().selection.primaryId).toBe('A');
    unmount();
  });

  // ──────────────────────── Alt/Option 端口修饰键跟踪 ────────────────────────
  it('case 25: pointermove 带 altKey 同步 isPortModifierHeld（Mac Option→RDP 链路稳健）', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    useStore.getState().setPortModifierHeld(false);

    // 按住 Alt/Option 移动鼠标 → pointermove(altKey=true) → held=true
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { altKey: true, bubbles: true })); });
    expect(useStore.getState().isPortModifierHeld).toBe(true);

    // 松开后移动 → pointermove(altKey=false) → held=false
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { altKey: false, bubbles: true })); });
    expect(useStore.getState().isPortModifierHeld).toBe(false);

    // pointerdown 也同步
    act(() => { window.dispatchEvent(new PointerEvent('pointerdown', { altKey: true, bubbles: true })); });
    expect(useStore.getState().isPortModifierHeld).toBe(true);

    // 卸载后不再响应（监听已移除）
    unmount();
    useStore.getState().setPortModifierHeld(false);
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { altKey: true, bubbles: true })); });
    expect(useStore.getState().isPortModifierHeld).toBe(false);
  });

  it('case 26: keydown/keyup 仍同步 isPortModifierHeld（静止按 Alt 也生效）', () => {
    const { unmount } = renderHook(() => useKeyboardDispatcher());
    useStore.getState().setPortModifierHeld(false);

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true })); });
    expect(useStore.getState().isPortModifierHeld).toBe(true);

    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', altKey: false, bubbles: true })); });
    expect(useStore.getState().isPortModifierHeld).toBe(false);

    unmount();
  });
});

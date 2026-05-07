/**
 * store_setHoveredPort.test.ts
 * ============================
 * 审计 Round 2 — setHoveredPort 0 单测，覆盖：
 *   - inActivePhase 三态门 (IDLE / SOURCE_LOCKED / AXIAL_SLIDING+continuousPlacementSource)
 *   - 300ms _hoveredPortClearTimer 防抖（A→B 切换不闪 / 单纯 leave 延迟清空）
 *   - 同 part 不同 portType 的 addLog 仅在 partId 改变时触发
 *
 * 用 vi.useFakeTimers() 控制 setTimeout，确保跨 test 的 timer 不泄漏到 module
 * 级 _hoveredPortClearTimer。每个 case 起前/末手动 advance + clear hoveredPort。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../store';
import { InteractionPhase } from '../types';

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

describe('store.setHoveredPort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({
      hoveredPort: null,
      selectedPort: null,
      continuousPlacementSource: null,
      interactionPhase: InteractionPhase.SOURCE_LOCKED,
      logs: [],
    } as any);
  });

  afterEach(() => {
    // 推进时间清掉所有挂着的 timer 防泄漏到下一个 test
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
  });

  it('case 1: 不在 active phase (IDLE) → 立即清空 + 取消任何待决 timer', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.IDLE,
      hoveredPort: makePort('A') as any,
    } as any);
    useStore.getState().setHoveredPort(makePort('B') as any);
    // IDLE 下 setHoveredPort 任何输入都无视，直接清空
    expect(useStore.getState().hoveredPort).toBeNull();
  });

  it('case 2: SOURCE_LOCKED + 非空 port → 立即写入', () => {
    useStore.getState().setHoveredPort(makePort('A') as any);
    expect(useStore.getState().hoveredPort?.partId).toBe('A');
  });

  it('case 3: SOURCE_LOCKED + null → 300ms 后清空，期间 hoveredPort 仍然保留', () => {
    useStore.setState({ hoveredPort: makePort('A') as any } as any);
    useStore.getState().setHoveredPort(null);
    // 立即查：仍是 A（防抖延迟）
    expect(useStore.getState().hoveredPort?.partId).toBe('A');
    // 推 299ms 仍未清
    vi.advanceTimersByTime(299);
    expect(useStore.getState().hoveredPort?.partId).toBe('A');
    // 推到 300ms 清空
    vi.advanceTimersByTime(2);
    expect(useStore.getState().hoveredPort).toBeNull();
  });

  it('case 4: A→B 切换不闪 — null 后 < 300ms 内 hover B → timer 取消，B 立即生效', () => {
    useStore.setState({ hoveredPort: makePort('A') as any } as any);
    useStore.getState().setHoveredPort(null);  // 启动 300ms timer
    vi.advanceTimersByTime(100);
    // 100ms 后 hover B → timer 应被取消
    useStore.getState().setHoveredPort(makePort('B') as any);
    expect(useStore.getState().hoveredPort?.partId).toBe('B');
    // 再推 300ms：B 不应被旧 timer 清空
    vi.advanceTimersByTime(300);
    expect(useStore.getState().hoveredPort?.partId).toBe('B');
  });

  it('case 5: AXIAL_SLIDING 但无 continuousPlacementSource → 不在 active，立即清空', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      continuousPlacementSource: null,
      hoveredPort: makePort('A') as any,
    } as any);
    useStore.getState().setHoveredPort(makePort('B') as any);
    expect(useStore.getState().hoveredPort).toBeNull();
  });

  it('case 6: AXIAL_SLIDING + continuousPlacementSource 非 null → 在 active phase，写入生效', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      continuousPlacementSource: makePort('SRC') as any,
      hoveredPort: null,
    } as any);
    useStore.getState().setHoveredPort(makePort('B') as any);
    expect(useStore.getState().hoveredPort?.partId).toBe('B');
  });

  it('case 7: 同 partId 不同 portType → 切换 hoveredPort 但不写新的 [Port HOVER] log（仅 partId 改变才 log）', () => {
    // 第一次 hover A peg.dat
    useStore.getState().setHoveredPort(makePort('A', 'peg.dat') as any);
    const logsAfterFirst = useStore.getState().logs.length;
    // 第二次 hover 同 partId A 但不同 port — 不 addLog
    useStore.getState().setHoveredPort(makePort('A', 'peghole.dat') as any);
    expect(useStore.getState().hoveredPort?.portType).toBe('peghole.dat');
    expect(useStore.getState().logs.length).toBe(logsAfterFirst); // 没多 log
  });

  it('case 8: 切到不同 partId → 写入新 [Port HOVER] log', () => {
    useStore.getState().setHoveredPort(makePort('A') as any);
    const logsAfterA = useStore.getState().logs.length;
    useStore.getState().setHoveredPort(makePort('B') as any);
    const log = useStore.getState().logs.find(l => l.message.includes('hoveredPort -> B'));
    expect(log).toBeDefined();
    expect(useStore.getState().logs.length).toBeGreaterThan(logsAfterA);
  });

  it('case 9: phase 离开 active 时 — clearTimer 路径覆盖（前一态有 timer，phase 切 IDLE 后再 setHoveredPort 应无副作用）', () => {
    // 在 SOURCE_LOCKED 启 timer
    useStore.setState({ hoveredPort: makePort('A') as any } as any);
    useStore.getState().setHoveredPort(null);
    // 切到 IDLE
    useStore.setState({ interactionPhase: InteractionPhase.IDLE } as any);
    // 任何 setHoveredPort 都被立即清；timer 也被取消
    useStore.getState().setHoveredPort(makePort('Z') as any);
    expect(useStore.getState().hoveredPort).toBeNull();
    // 推时间，旧 timer 已经被新 setHoveredPort 取消，不再触发
    vi.advanceTimersByTime(500);
    expect(useStore.getState().hoveredPort).toBeNull();
  });
});

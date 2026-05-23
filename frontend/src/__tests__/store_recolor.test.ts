/**
 * store_recolor.test.ts
 * =====================
 * 已放置零件改色（recolorSelected）集成：选中件改色、功能预设色件跳过、可撤销。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';
import { ZoneType, InteractionPhase, SelectionLevel } from '../types';

function resetStore() {
  let safety = 200;
  while (safety-- > 0 && useStore.getState().canUndo) useStore.getState().undo();
  useStore.setState({
    parts: {}, connections: {}, occupiedPorts: {}, logs: [],
    interactionPhase: InteractionPhase.IDLE,
    selection: { primaryId: null, level: SelectionLevel.INDIVIDUAL, allConnectedIds: [], excludedIds: [] },
  } as any);
}

const part = (ldrawId: string, colorCode: number) => ({
  ldrawId, position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode, zone: ZoneType.ACTIVE_ARENA,
});

describe('recolorSelected', () => {
  beforeEach(resetStore);

  it('单选普通件 → 改色 + 可 undo', () => {
    useStore.setState({
      parts: { plate: part('71709.dat', 4) },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate'], excludedIds: [] },
    } as any);

    useStore.getState().recolorSelected(14);
    expect(useStore.getState().parts.plate.colorCode).toBe(14);
    expect(useStore.getState().canUndo).toBe(true);

    useStore.getState().undo();
    expect(useStore.getState().parts.plate.colorCode).toBe(4);
  });

  it('多选：普通件改色，功能预设色件（销）跳过', () => {
    useStore.setState({
      parts: { plate: part('71709.dat', 4), pin: part('3673.dat', 71) },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate', 'pin'], excludedIds: [] },
    } as any);

    useStore.getState().recolorSelected(2);
    const st = useStore.getState();
    expect(st.parts.plate.colorCode).toBe(2);   // 改了
    expect(st.parts.pin.colorCode).toBe(71);    // 销锁色，不变
  });

  it('选中全是功能预设色件 → no-op（不入 undo 栈）+ INFO 提示', () => {
    useStore.setState({
      parts: { pin: part('3673.dat', 71) },
      selection: { primaryId: 'pin', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['pin'], excludedIds: [] },
    } as any);

    useStore.getState().recolorSelected(2);
    const st = useStore.getState();
    expect(st.parts.pin.colorCode).toBe(71);
    expect(st.canUndo).toBe(false);
    expect(st.logs.some(l => l.type === 'INFO' && l.message.includes('锁定'))).toBe(true);
  });

  it('已是目标色 → no-op（免空命令）', () => {
    useStore.setState({
      parts: { plate: part('71709.dat', 14) },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate'], excludedIds: [] },
    } as any);
    useStore.getState().recolorSelected(14);
    expect(useStore.getState().canUndo).toBe(false);
  });

  it('无选中 → no-op', () => {
    useStore.setState({ parts: { plate: part('71709.dat', 4) } } as any);
    useStore.getState().recolorSelected(2);
    expect(useStore.getState().parts.plate.colorCode).toBe(4);
    expect(useStore.getState().canUndo).toBe(false);
  });
});

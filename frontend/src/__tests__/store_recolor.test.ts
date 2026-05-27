/**
 * store_recolor.test.ts
 * =====================
 * 已放置零件改色（recolorSelected）集成。
 *
 * 全锁语义：库内零件一律固定惯例色（hasPresetColor=true），改色对其跳过；
 * 仅库外 / 未知件（不在生成表内，如自定义件）可改色。可撤销。
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

// 库外（不在生成表）件 → 可改色；71709(Panel)/3673(Pin) 为库内全锁件。
const CUSTOM = 'zzz_custom_999.dat';

describe('recolorSelected', () => {
  beforeEach(resetStore);

  it('单选库外件 → 改色 + 可 undo', () => {
    useStore.setState({
      parts: { custom: part(CUSTOM, 4) },
      selection: { primaryId: 'custom', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['custom'], excludedIds: [] },
    } as any);

    useStore.getState().recolorSelected(14);
    expect(useStore.getState().parts.custom.colorCode).toBe(14);
    expect(useStore.getState().canUndo).toBe(true);

    useStore.getState().undo();
    expect(useStore.getState().parts.custom.colorCode).toBe(4);
  });

  it('多选：库外件改色，库内固定色件（板 / 销）跳过', () => {
    useStore.setState({
      parts: { custom: part(CUSTOM, 4), panel: part('71709.dat', 71), pin: part('3673.dat', 71) },
      selection: { primaryId: 'custom', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['custom', 'panel', 'pin'], excludedIds: [] },
    } as any);

    useStore.getState().recolorSelected(2);
    const st = useStore.getState();
    expect(st.parts.custom.colorCode).toBe(2);  // 改了
    expect(st.parts.panel.colorCode).toBe(71);  // 库内锁色，不变
    expect(st.parts.pin.colorCode).toBe(71);    // 库内锁色，不变
  });

  it('选中全是库内固定色件 → no-op（不入 undo 栈）+ INFO 提示', () => {
    useStore.setState({
      parts: { panel: part('71709.dat', 71), pin: part('3673.dat', 71) },
      selection: { primaryId: 'panel', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['panel', 'pin'], excludedIds: [] },
    } as any);

    useStore.getState().recolorSelected(2);
    const st = useStore.getState();
    expect(st.parts.panel.colorCode).toBe(71);
    expect(st.parts.pin.colorCode).toBe(71);
    expect(st.canUndo).toBe(false);
    expect(st.logs.some(l => l.type === 'INFO' && l.message.includes('锁定'))).toBe(true);
  });

  it('已是目标色 → no-op（免空命令）', () => {
    useStore.setState({
      parts: { custom: part(CUSTOM, 14) },
      selection: { primaryId: 'custom', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['custom'], excludedIds: [] },
    } as any);
    useStore.getState().recolorSelected(14);
    expect(useStore.getState().canUndo).toBe(false);
  });

  it('无选中 → no-op', () => {
    useStore.setState({ parts: { custom: part(CUSTOM, 4) } } as any);
    useStore.getState().recolorSelected(2);
    expect(useStore.getState().parts.custom.colorCode).toBe(4);
    expect(useStore.getState().canUndo).toBe(false);
  });
});

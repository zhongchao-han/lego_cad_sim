/**
 * store_rotate_single.test.ts
 * ===========================
 * Feature A 集成层：store.rotateSelectedSingle 把纯几何决策
 * (evaluateRotateReconnect) 落到 parts/connections/occupiedPorts，并可撤销。
 *
 * 几何正确性在 rotateReconnect.test.ts 覆盖；这里验证 store 状态装配/拆解 + undo。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, portKey } from '../store';
import { ZoneType, InteractionPhase, SelectionLevel } from '../types';

type V3 = [number, number, number];
const A = 0.008;

function resetStore() {
  let safety = 200;
  while (safety-- > 0 && useStore.getState().canUndo) useStore.getState().undo();
  useStore.setState({
    parts: {}, connections: {}, occupiedPorts: {},
    selectedPort: null, hoveredPort: null, slidingTarget: null, slideOffset: 0,
    snapPreState: null, continuousPlacementSource: null,
    interactionPhase: InteractionPhase.IDLE, logs: [],
    partCatalog: {},
    selection: { primaryId: null, level: SelectionLevel.INDIVIDUAL, allConnectedIds: [], excludedIds: [] },
  } as any);
}

function part(ldrawId: string) {
  return {
    ldrawId, position: [0, 0, 0] as V3, quaternion: [0, 0, 0, 1] as [number, number, number, number],
    colorCode: 4, zone: ZoneType.ACTIVE_ARENA,
  };
}

/** 把 P 与 Q 用一组局部端口坐标互相占用 + 建连通边。 */
function connect(P: string, Q: string, localPorts: V3[]) {
  const s = useStore.getState();
  const occ = { ...s.occupiedPorts };
  occ[P] = { ...(occ[P] || {}) };
  occ[Q] = { ...(occ[Q] || {}) };
  localPorts.forEach(p => {
    occ[P][portKey(p)] = Q;
    occ[Q][portKey(p)] = P;
  });
  const conn = { ...s.connections };
  conn[P] = new Set([...(conn[P] || []), Q]);
  conn[Q] = new Set([...(conn[Q] || []), P]);
  useStore.setState({ occupiedPorts: occ, connections: conn } as any);
}

function setup(localPorts: V3[]) {
  resetStore();
  useStore.setState({
    parts: { P: part('P.dat'), Q: part('Q.dat') },
    partCatalog: { 'P.dat': { bboxCenter: [0, 0, 0] }, 'Q.dat': { bboxCenter: [0, 0, 0] } },
    selection: { primaryId: 'P', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['P'], excludedIds: [] },
  } as any);
  connect('P', 'Q', localPorts);
}

describe('rotateSelectedSingle — 集成（重连/脱开 + undo）', () => {
  beforeEach(resetStore);

  it('对称方阵端口：转 90° 端口映射回自身 → 连接保持，姿态改变', () => {
    setup([[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]]);
    const q0 = [...useStore.getState().parts.P.quaternion];

    useStore.getState().rotateSelectedSingle(Math.PI / 2);

    const st = useStore.getState();
    // 连接保持
    expect(st.connections.P.has('Q')).toBe(true);
    expect(st.connections.Q.has('P')).toBe(true);
    expect(Object.keys(st.occupiedPorts.P).length).toBe(4);
    // 姿态确实转了
    expect(st.parts.P.quaternion).not.toEqual(q0);
  });

  it('沿 X 双点端口：转 90° 变沿 Z，微移无法复原 → 脱开（连接+占用双侧清除）', () => {
    setup([[A, 0, 0], [-A, 0, 0]]);

    useStore.getState().rotateSelectedSingle(Math.PI / 2);

    const st = useStore.getState();
    // 连接断开（双向）
    expect(st.connections.P?.has('Q') ?? false).toBe(false);
    expect(st.connections.Q?.has('P') ?? false).toBe(false);
    // 互指占用条目清空
    expect(st.occupiedPorts.P ?? {}).toEqual({});
    expect(st.occupiedPorts.Q ?? {}).toEqual({});
  });

  it('脱开后 undo 应恢复连接、占用与姿态', () => {
    setup([[A, 0, 0], [-A, 0, 0]]);
    const q0 = [...useStore.getState().parts.P.quaternion];
    const occP0 = { ...useStore.getState().occupiedPorts.P };

    useStore.getState().rotateSelectedSingle(Math.PI / 2);
    expect(useStore.getState().connections.P?.has('Q') ?? false).toBe(false);

    useStore.getState().undo();

    const st = useStore.getState();
    expect(st.connections.P.has('Q')).toBe(true);
    expect(st.connections.Q.has('P')).toBe(true);
    expect(st.occupiedPorts.P).toEqual(occP0);
    expect(st.parts.P.quaternion).toEqual(q0);
  });

  it('无选中件 → no-op', () => {
    resetStore();
    useStore.setState({ parts: { P: part('P.dat') }, partCatalog: { 'P.dat': { bboxCenter: [0, 0, 0] } } } as any);
    // selection.primaryId 为 null
    expect(() => useStore.getState().rotateSelectedSingle(Math.PI / 2)).not.toThrow();
    expect(useStore.getState().parts.P.quaternion).toEqual([0, 0, 0, 1]);
  });
});

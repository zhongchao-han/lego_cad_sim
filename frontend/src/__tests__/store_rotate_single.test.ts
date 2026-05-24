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
    // Q 是大底板（bbox 体积大）→ pickBasePart 选 Q 为地基；P 是被转的小件。
    partCatalog: {
      'P.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
      'Q.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.01, 0.2] },
    },
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

  it('插销跟上：转板时挂在板上的插销随板一起转（相对大底板）', () => {
    resetStore();
    const square: V3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    useStore.setState({
      parts: { plate: part('plate.dat'), base: part('base.dat'), pin: part('pin.dat') },
      partCatalog: {
        'plate.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
        'base.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.01, 0.2] }, // 最大 → 地基
        'pin.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.002, 0.02, 0.002] },
      },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate'], excludedIds: [] },
    } as any);
    connect('plate', 'base', square);      // 板↔底板：对称方阵（转 90° 保持）
    connect('plate', 'pin', [[0, A, 0]]);  // 插销插在板顶（moving 组内部连接）

    const pinQ0 = [...useStore.getState().parts.pin.quaternion];

    useStore.getState().rotateSelectedSingle(Math.PI / 2);

    const st = useStore.getState();
    // 插销随板转了（姿态改变）
    expect(st.parts.pin.quaternion).not.toEqual(pinQ0);
    // 板↔插销内部连接保持
    expect(st.connections.plate.has('pin')).toBe(true);
    expect(st.connections.pin.has('plate')).toBe(true);
    // 板↔底板对称方阵 → 保持
    expect(st.connections.plate.has('base')).toBe(true);
  });

  it('平移「整体一起动」：选 P → 与之相连的 Q 也一起移动，连接保持', () => {
    const square: V3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    setup(square); // P 小件（选中，allConnectedIds=['P']）、Q 与 P 相连

    useStore.getState().translateSelectedGroup([-0.008, 0, 0]);

    const st = useStore.getState();
    // 整个连通装配一起平移：P 和相连的 Q 都移动 -8mm
    expect(st.parts.P.position[0]).toBeCloseTo(-0.008, 6);
    expect(st.parts.Q.position[0]).toBeCloseTo(-0.008, 6);
    // 连接保持（刚体一起动，不脱开）
    expect(st.connections.P.has('Q')).toBe(true);
    expect(st.connections.Q.has('P')).toBe(true);

    // undo 恢复位置
    useStore.getState().undo();
    const r = useStore.getState();
    expect(r.parts.P.position[0]).toBeCloseTo(0, 6);
    expect(r.parts.Q.position[0]).toBeCloseTo(0, 6);
  });

  it('平移「整体一起动」：选 plate → 相连的 pin 和 base 全部一起动，连接全保留', () => {
    resetStore();
    const square: V3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    useStore.setState({
      parts: { plate: part('plate.dat'), base: part('base.dat'), pin: part('pin.dat') },
      partCatalog: {
        'plate.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
        'base.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.01, 0.2] },
        'pin.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.002, 0.02, 0.002] },
      },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate'], excludedIds: [] },
    } as any);
    connect('plate', 'base', square);
    connect('plate', 'pin', [[0, A, 0]]);

    useStore.getState().translateSelectedGroup([0, 0, 0.008]);

    const st = useStore.getState();
    // plate / pin / base 同属一个连通装配 → 全部一起平移
    expect(st.parts.plate.position[2]).toBeCloseTo(0.008, 6);
    expect(st.parts.pin.position[2]).toBeCloseTo(0.008, 6);
    expect(st.parts.base.position[2]).toBeCloseTo(0.008, 6);
    // 连接全保留
    expect(st.connections.plate.has('pin')).toBe(true);
    expect(st.connections.plate.has('base')).toBe(true);
  });

  it('平移「整体一起动」：未相连的独立件不受影响', () => {
    resetStore();
    useStore.setState({
      parts: {
        plate: part('plate.dat'),
        base: part('base.dat'),
        lone: part('lone.dat'), // 独立件，不与 plate 相连
      },
      partCatalog: {
        'plate.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
        'base.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.01, 0.2] },
        'lone.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.02, 0.01, 0.02] },
      },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate'], excludedIds: [] },
    } as any);
    connect('plate', 'base', [[A, 0, A]]);
    const lonePos0 = [...useStore.getState().parts.lone.position];

    useStore.getState().translateSelectedGroup([0.008, 0, 0]);

    const st = useStore.getState();
    expect(st.parts.plate.position[0]).toBeCloseTo(0.008, 6); // plate 动
    expect(st.parts.base.position[0]).toBeCloseTo(0.008, 6);  // 相连的 base 一起动
    expect(st.parts.lone.position).toEqual(lonePos0);         // 不相连的独立件不动
  });

  it('翻面：选中件绕世界 X 翻 180°，连接件(销)留在原位不翻到顶，地基不动', () => {
    resetStore();
    const square: V3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    useStore.setState({
      parts: { plate: part('plate.dat'), base: part('base.dat'), pin: part('pin.dat') },
      partCatalog: {
        // pin 标为 Pin 类 → 翻面时留在原位充当连接，不随板翻
        'plate.dat': { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
        'base.dat': { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.01, 0.2] },
        'pin.dat': { category: 'Pin', bboxCenter: [0, 0, 0], bboxSize: [0.002, 0.02, 0.002] },
      },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate'], excludedIds: [] },
    } as any);
    connect('plate', 'base', square);
    connect('plate', 'pin', [[0, A, 0]]);
    const baseQ0 = [...useStore.getState().parts.base.quaternion];
    const pinQ0 = [...useStore.getState().parts.pin.quaternion];
    const pinP0 = [...useStore.getState().parts.pin.position];

    useStore.getState().flipSelected();

    const st = useStore.getState();
    // 板绕世界 X 翻 180° → 四元数 x 分量 ≈ ±1
    expect(Math.abs(st.parts.plate.quaternion[0])).toBeCloseTo(1, 4);
    // 销是连接件 → 不随板翻：姿态 + 位置都不变（留在原位充当连接）
    expect(st.parts.pin.quaternion).toEqual(pinQ0);
    expect(st.parts.pin.position).toEqual(pinP0);
    // 地基不动
    expect(st.parts.base.quaternion).toEqual(baseQ0);
    expect(st.canUndo).toBe(true);
  });

  it('无选中件 → no-op', () => {
    resetStore();
    useStore.setState({ parts: { P: part('P.dat') }, partCatalog: { 'P.dat': { bboxCenter: [0, 0, 0] } } } as any);
    // selection.primaryId 为 null
    expect(() => useStore.getState().rotateSelectedSingle(Math.PI / 2)).not.toThrow();
    expect(useStore.getState().parts.P.quaternion).toEqual([0, 0, 0, 1]);
  });
});

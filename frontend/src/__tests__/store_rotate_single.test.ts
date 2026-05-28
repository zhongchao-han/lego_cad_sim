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
    // Q 是大底板（bbox 底面更低）→ 树模型选 Q 为地基(根)；P 是被转的件。位置都在
    // 原点，端口重合；Q bbox 更高仅用于把它的底面压到 P 之下当根，不影响端口几何。
    partCatalog: {
      'P.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
      'Q.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.02, 0.2] },
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

    useStore.getState().rotateSelectedSingle([0, 1, 0], Math.PI / 2);

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

    useStore.getState().rotateSelectedSingle([0, 1, 0], Math.PI / 2);

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

    useStore.getState().rotateSelectedSingle([0, 1, 0], Math.PI / 2);
    expect(useStore.getState().connections.P?.has('Q') ?? false).toBe(false);

    useStore.getState().undo();

    const st = useStore.getState();
    expect(st.connections.P.has('Q')).toBe(true);
    expect(st.connections.Q.has('P')).toBe(true);
    expect(st.occupiedPorts.P).toEqual(occP0);
    expect(st.parts.P.quaternion).toEqual(q0);
  });

  it('插销跟上 + 地基不动：转板时销随板一起转，地基(最低件)不被转走', () => {
    resetStore();
    const square: V3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    useStore.setState({
      parts: {
        plate: { ...part('plate.dat'), position: [0, 0, 0] as V3 },
        base: { ...part('base.dat'), position: [0, -0.01, 0] as V3 }, // 最低 → 树根（地基）
        pin: { ...part('pin.dat'), position: [0, 0.012, 0] as V3 },   // 挂在板顶的销=胶水
      },
      partCatalog: {
        'plate.dat': { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
        'base.dat': { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.01, 0.2] },
        'pin.dat': { category: 'Pin', bboxCenter: [0, 0, 0], bboxSize: [0.002, 0.02, 0.002] },
      },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate'], excludedIds: [] },
    } as any);
    connect('plate', 'base', square);      // 板↔底板：对称方阵（转 90° + 微移保持）
    connect('plate', 'pin', [[0, A, 0]]);  // 插销插在板顶（moving 组内部连接）

    const pinQ0 = [...useStore.getState().parts.pin.quaternion];
    const baseQ0 = [...useStore.getState().parts.base.quaternion];

    useStore.getState().rotateSelectedSingle([0, 1, 0], Math.PI / 2);

    const st = useStore.getState();
    // 插销随板转了（姿态改变）
    expect(st.parts.pin.quaternion).not.toEqual(pinQ0);
    // 地基（最低件）不被转走 —— 本 bug 的核心修复点
    expect(st.parts.base.quaternion).toEqual(baseQ0);
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

  it('翻面（树模型 B）：选中件子树(含销)整体翻 180°、内部连接保留，地基不动、界面脱开', () => {
    resetStore();
    const square: V3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    useStore.setState({
      parts: {
        plate: { ...part('plate.dat'), position: [0, 0.008, 0] as V3 },     // 中层板
        base: { ...part('base.dat'), position: [0, -0.01, 0] as V3 },        // 最低 → 树根（地基）
        pin: { ...part('pin.dat'), position: [0, 0.012, 0] as V3 },          // 挂在板上面的销
      },
      partCatalog: {
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

    useStore.getState().flipSelected();

    const st = useStore.getState();
    // 板翻了
    expect(Math.abs(st.parts.plate.quaternion[0])).toBeCloseTo(1, 4);
    // 销在板的子树里 → 跟着板一起翻（姿态改变），内部连接保留
    expect(st.parts.pin.quaternion).not.toEqual(pinQ0);
    expect(st.connections.plate.has('pin')).toBe(true);
    expect(st.connections.pin.has('plate')).toBe(true);
    // 地基(root)位姿不动（不参与刚体翻转）
    expect(st.parts.base.quaternion).toEqual(baseQ0);
    // 这里 4 孔方阵在 180° 翻转下映射回自身（对称）→ autoMove 复位后界面仍重合 → 保持。
    // （真实面板孔在底面、翻转后跑到顶上、对不齐 → 会脱开；行为由几何决定。）
    expect(st.connections.plate.has('base')).toBe(true);
    expect(st.canUndo).toBe(true);
  });

  it('单件平移（树模型）：选 plate → 只有 plate 动、地基 base 不动，错位连接脱开', async () => {
    resetStore();
    const square: V3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    useStore.setState({
      parts: {
        plate: { ...part('plate.dat'), position: [0, 0, 0] as V3 },
        base: { ...part('base.dat'), position: [0, -0.01, 0] as V3 }, // 更低 → 树根（地基）
      },
      partCatalog: {
        'plate.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
        'base.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.01, 0.2] },
      },
      selection: { primaryId: 'plate', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['plate'], excludedIds: [] },
    } as any);
    connect('plate', 'base', square);

    await useStore.getState().translateSelectedSingle([0.008, 0, 0]);

    const st = useStore.getState();
    expect(st.parts.plate.position[0]).toBeCloseTo(0.008, 6); // plate 动
    expect(st.parts.base.position[0]).toBeCloseTo(0, 6);      // 地基不动
    // 错位（jsdom 无端口几何可吸附）→ 脱开
    expect(st.connections.plate?.has('base') ?? false).toBe(false);
    expect(st.connections.base?.has('plate') ?? false).toBe(false);
    // undo 恢复位置 + 连接
    useStore.getState().undo();
    const r = useStore.getState();
    expect(r.parts.plate.position[0]).toBeCloseTo(0, 6);
    expect(r.connections.plate.has('base')).toBe(true);
  });

  it('单件平移（树模型）：选地基 base（树根）→ 整个装配一起搬，连接保留', async () => {
    resetStore();
    const square: V3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    useStore.setState({
      parts: {
        plate: { ...part('plate.dat'), position: [0, 0, 0] as V3 },
        base: { ...part('base.dat'), position: [0, -0.01, 0] as V3 },
      },
      partCatalog: {
        'plate.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.03, 0.01, 0.01] },
        'base.dat': { bboxCenter: [0, 0, 0], bboxSize: [0.3, 0.01, 0.2] },
      },
      selection: { primaryId: 'base', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['base'], excludedIds: [] },
    } as any);
    connect('plate', 'base', square);

    await useStore.getState().translateSelectedSingle([0.008, 0, 0]);

    const st = useStore.getState();
    // 抓住地基（根）→ 整组都动
    expect(st.parts.base.position[0]).toBeCloseTo(0.008, 6);
    expect(st.parts.plate.position[0]).toBeCloseTo(0.008, 6);
    // 整组刚体动、无界面 → 连接保留
    expect(st.connections.plate.has('base')).toBe(true);
    expect(st.connections.base.has('plate')).toBe(true);
  });

  it('单件平移（树模型）：并排同高两块板靠销桥接 → 只动抓起的左板，右板不跟动', async () => {
    resetStore();
    // L、R 两块同高的板（都在 y=0），靠一颗销 pin 横向桥接（pin=胶水）。
    useStore.setState({
      parts: {
        L: { ...part('L.dat'), position: [-0.1, 0, 0] as V3 },
        R: { ...part('R.dat'), position: [0.1, 0, 0] as V3 },
        pin: { ...part('pin.dat'), position: [0, 0, 0] as V3 },
      },
      partCatalog: {
        'L.dat': { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.16, 0.012, 0.26] },
        'R.dat': { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.16, 0.012, 0.26] },
        'pin.dat': { category: 'Pin', bboxCenter: [0, 0, 0], bboxSize: [0.02, 0.006, 0.006] },
      },
      selection: { primaryId: 'L', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['L'], excludedIds: [] },
    } as any);
    connect('L', 'pin', [[0.08, 0, 0]]);
    connect('R', 'pin', [[-0.08, 0, 0]]);

    await useStore.getState().translateSelectedSingle([-0.05, 0, 0]);

    const st = useStore.getState();
    expect(st.parts.L.position[0]).toBeCloseTo(-0.15, 6); // 抓起的左板动了
    expect(st.parts.R.position[0]).toBeCloseTo(0.1, 6);   // 右板（当参考地基）不跟动
  });

  it('单件平移（树模型）：移左底板 → 它上面的平板跟随，右底板（同高、销桥接）不动', async () => {
    resetStore();
    // 截图场景：左右两底板同高、靠销桥接；左底板上叠一块平板 P（更高）。
    useStore.setState({
      parts: {
        LB: { ...part('lb.dat'), position: [-0.1, 0, 0] as V3 },
        RB: { ...part('rb.dat'), position: [0.1, 0, 0] as V3 },
        P:  { ...part('p.dat'),  position: [-0.1, 0.026, 0] as V3 }, // 叠在左底板上
        pin: { ...part('pin.dat'), position: [0, 0, 0] as V3 },      // 桥接 LB-RB 的胶水
      },
      partCatalog: {
        'lb.dat': { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.16, 0.04, 0.26] },
        'rb.dat': { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.16, 0.04, 0.26] },
        'p.dat':  { category: 'Plate', bboxCenter: [0, 0, 0], bboxSize: [0.06, 0.012, 0.06] },
        'pin.dat': { category: 'Pin', bboxCenter: [0, 0, 0], bboxSize: [0.02, 0.006, 0.006] },
      },
      selection: { primaryId: 'LB', level: SelectionLevel.INDIVIDUAL, allConnectedIds: ['LB'], excludedIds: [] },
    } as any);
    connect('LB', 'pin', [[0.08, 0, 0]]);   // 销桥接左右底板
    connect('RB', 'pin', [[-0.08, 0, 0]]);
    connect('LB', 'P', [[0, 0.02, 0]]);      // 平板叠在左底板顶

    await useStore.getState().translateSelectedSingle([-0.05, 0, 0]);

    const st = useStore.getState();
    expect(st.parts.LB.position[0]).toBeCloseTo(-0.15, 6); // 左底板动
    expect(st.parts.P.position[0]).toBeCloseTo(-0.15, 6);  // 上面的平板跟随
    expect(st.parts.RB.position[0]).toBeCloseTo(0.1, 6);   // 右底板（同高、当参考）不动
  });

  it('无选中件 → no-op', () => {
    resetStore();
    useStore.setState({ parts: { P: part('P.dat') }, partCatalog: { 'P.dat': { bboxCenter: [0, 0, 0] } } } as any);
    // selection.primaryId 为 null
    expect(() => useStore.getState().rotateSelectedSingle([0, 1, 0], Math.PI / 2)).not.toThrow();
    expect(useStore.getState().parts.P.quaternion).toEqual([0, 0, 0, 1]);
  });
});

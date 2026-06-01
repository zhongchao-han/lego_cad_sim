/**
 * store_commit_undo.test.ts
 * =========================
 * 审计 Round 3-A — commitAxialSliding 连续放置分支 + SnapCommand undo/redo round-trip
 *
 * Round 1/2 已经覆盖 abortCurrentInteraction (PR #70) + handlePortClick 状态机
 * (continuousPlacement.test.ts) + snapParts API contract (store_snap_api)。
 *
 * 这一组补：
 *   - commitAxialSliding 在 continuousPlacementSource 非 null 时走 cp 分支
 *     (生成新 instanceId / 保持 selectedPort / phase 重入 SOURCE_LOCKED)
 *   - SnapCommand 的 undo + redo 双向回放：parts 位姿 / connections 双向 /
 *     occupiedPorts 端口键 / addedPartIds 整零件存活
 *
 * 不 mock axios（这些 action 不打后端）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
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

function resetStore() {
  // _history 是 store 模块级变量，没法直接 import 来 reset。先通过反复 undo
  // 把它清空（store.canUndo 是 _history.canUndo 的镜像，可作为终止条件）。
  // setState 必须放在 undo loop 之后，否则覆盖 canUndo:false 会跳过 loop。
  let safety = 200;
  while (safety-- > 0 && useStore.getState().canUndo) {
    useStore.getState().undo();
  }
  useStore.setState({
    parts: {},
    connections: {},
    occupiedPorts: {},
    selectedPort: null,
    hoveredPort: null,
    slidingTarget: null,
    slideOffset: 0,
    snapPreState: null,
    continuousPlacementSource: null,
    interactionPhase: InteractionPhase.IDLE,
    logs: [],
  } as any);
}

// ─────────────────────────────────────────────────────────────────────────
// commitAxialSliding 连续放置分支
// ─────────────────────────────────────────────────────────────────────────
describe('store.commitAxialSliding — continuous placement branch', () => {
  beforeEach(resetStore);

  it('case 1: snapPreState=null + cp=null → 普通 commit (phase=IDLE, selectedPort=null)', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      selectedPort: makePort('A') as any,
      slidingTarget: makePort('B') as any,
      slideOffset: 5,
    } as any);
    useStore.getState().commitAxialSliding();
    const s = useStore.getState();
    expect(s.interactionPhase).toBe(InteractionPhase.IDLE);
    expect(s.selectedPort).toBeNull();
    expect(s.slideOffset).toBe(0);
    expect(s.slidingTarget).toBeNull();
  });

  it('case 2: cp 非 null → 重入 SOURCE_LOCKED + 新 instanceId + selectedPort 替换 (保留 ldrawId/portType/rotation)', () => {
    const cp = {
      ...makePort('SOURCE_INIT'),
      ldrawId: '2780.dat',
      portType: 'peg.dat',
      isFromPreview: true,
    };
    useStore.setState({
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      selectedPort: makePort('OLD') as any,
      slidingTarget: makePort('B') as any,
      slideOffset: 3,
      continuousPlacementSource: cp as any,
    } as any);
    useStore.getState().commitAxialSliding();
    const s = useStore.getState();
    expect(s.interactionPhase).toBe(InteractionPhase.SOURCE_LOCKED);
    // selectedPort 是 cp + 新 instanceId
    expect(s.selectedPort).not.toBeNull();
    expect(s.selectedPort!.ldrawId).toBe('2780.dat');
    expect(s.selectedPort!.portType).toBe('peg.dat');
    // 新 instanceId 形如 "2780.dat_xxxxxxxx"
    expect(s.selectedPort!.partId).toMatch(/^2780\.dat_[a-f0-9]{8}$/);
    expect(s.selectedPort!.partId).not.toBe('OLD');
    // slideOffset / slidingTarget 应清，但 continuousPlacementSource 保留
    expect(s.slideOffset).toBe(0);
    expect(s.slidingTarget).toBeNull();
    expect(s.continuousPlacementSource).not.toBeNull();
  });

  it('case 3: 连续 commit 两次 → 每次新 instanceId 不同，stamp 模式持续', () => {
    const cp = { ...makePort('SOURCE'), ldrawId: '2780.dat', isFromPreview: true };
    useStore.setState({
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      selectedPort: makePort('A1') as any,
      continuousPlacementSource: cp as any,
    } as any);
    useStore.getState().commitAxialSliding();
    const id1 = useStore.getState().selectedPort!.partId;
    useStore.setState({ interactionPhase: InteractionPhase.AXIAL_SLIDING } as any);
    useStore.getState().commitAxialSliding();
    const id2 = useStore.getState().selectedPort!.partId;
    expect(id1).not.toBe(id2);
    // continuousPlacementSource 仍在
    expect(useStore.getState().continuousPlacementSource).not.toBeNull();
  });

  it('case 4: cp commit 后 addLog 含 "Ready for next continuous placement"', () => {
    useStore.setState({
      continuousPlacementSource: { ...makePort('S'), ldrawId: '2780.dat' } as any,
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
    } as any);
    useStore.getState().commitAxialSliding();
    const log = useStore.getState().logs.find(l => l.message.includes('continuous placement'));
    expect(log).toBeDefined();
  });

  it('case 5: 普通 commit 后 addLog 仅 "Axial Sliding committed"，不含 continuous', () => {
    useStore.setState({ interactionPhase: InteractionPhase.AXIAL_SLIDING } as any);
    useStore.getState().commitAxialSliding();
    const logs = useStore.getState().logs;
    expect(logs.some(l => l.message === 'Axial Sliding committed.')).toBe(true);
    expect(logs.some(l => l.message.includes('continuous'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SnapCommand undo/redo round-trip
// ─────────────────────────────────────────────────────────────────────────
describe('store.undo/redo — SnapCommand round-trip', () => {
  beforeEach(resetStore);

  function setupSnappedState() {
    // 模拟 handlePortClick → snapParts 已经写入本地状态:
    //   parts.pin 是新建零件; parts.plate 已存在; 二者已建 connection
    useStore.setState({
      parts: {
        plate: { ldrawId: 'plate.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        // pin 是新建零件，addedPartIds 包含它；undo 应整删
        pin:   { ldrawId: 'pin.dat',   position: [0.05, 0.02, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: {
        plate: new Set(['pin']),
        pin:   new Set(['plate']),
      },
      occupiedPorts: {
        plate: { 'pkey1|nz1': 'pin' },
        pin:   { 'pkey2|nz2': 'plate' },
      },
      // snapPreState 模拟 handlePortClick 在 commit 前已设：
      //   movedPartIds=[pin]（snap 时整组刚体只动了 pin）
      //   prevPositions：pin 落盘前位置
      //   addedConnections：plate↔pin 是新建边
      //   addedPartIds=[pin]（pin 是从 preview 直接落地的，新增零件）
      //   addedPortKeys：双向键
      snapPreState: {
        movedPartIds: ['pin'],
        prevPositions: {
          pin: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
        },
        addedConnections: [{ from: 'pin', to: 'plate' }],
        addedPartIds: ['pin'],
        addedPortKeys: [
          { partId: 'plate', key: 'pkey1|nz1', peerId: 'pin' },
          { partId: 'pin',   key: 'pkey2|nz2', peerId: 'plate' },
        ],
      },
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
    } as any);
  }

  it('case 6: commitAxialSliding 推 SnapCommand 后 canUndo=true', () => {
    setupSnappedState();
    useStore.getState().commitAxialSliding();
    expect(useStore.getState().canUndo).toBe(true);
    expect(useStore.getState().canRedo).toBe(false);
  });

  it('case 7: undo → addedPartIds 整零件移除 + connections 双向清 + occupiedPorts 清', () => {
    setupSnappedState();
    useStore.getState().commitAxialSliding();
    useStore.getState().undo();
    const s = useStore.getState();
    // pin 应被整删（addedPartIds=[pin]）
    expect(s.parts.pin).toBeUndefined();
    expect(s.parts.plate).toBeDefined();
    // connections 双向清（pin ↔ plate 唯一边，size 0 → 整 key 删）
    expect(s.connections.plate).toBeUndefined();
    expect(s.connections.pin).toBeUndefined();
    // occupiedPorts 清
    expect(s.occupiedPorts.plate).toBeUndefined();
    expect(s.occupiedPorts.pin).toBeUndefined();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(true);
  });

  it('case 8: redo 完整重建 — addedPartIds 用 capture 的 PartState 重建 + nextPositions 应用最终位姿 + connections / occupiedPorts 重建 (修自 issue #73)', () => {
    // 修复后 SnapCommand 在 commit 时额外 capture addedPartStates；redo 先用
    // capture state 重建被 undo 删过的 addedPartIds，再 apply nextPositions
    // 更新位姿。round-trip 对新增零件完全可逆。
    setupSnappedState();
    const pinPosBeforeCommit = { ...useStore.getState().parts.pin };
    useStore.getState().commitAxialSliding();
    useStore.getState().undo();
    expect(useStore.getState().parts.pin).toBeUndefined(); // pin 整删
    useStore.getState().redo();
    const s = useStore.getState();
    // pin 被 redo 重建：完整 PartState（ldrawId / colorCode / zone / pose）
    expect(s.parts.pin).toBeDefined();
    expect(s.parts.pin.ldrawId).toBe(pinPosBeforeCommit.ldrawId);
    expect(s.parts.pin.colorCode).toBe(pinPosBeforeCommit.colorCode);
    expect(s.parts.pin.zone).toBe(pinPosBeforeCommit.zone);
    expect(s.parts.pin.position).toEqual(pinPosBeforeCommit.position);
    // connections / occupiedPorts 重建后不再引用 dangling part（pin 真实存在了）
    expect(s.connections.plate?.has('pin')).toBe(true);
    expect(s.occupiedPorts.plate?.['pkey1|nz1']).toBe('pin');
    expect(s.canRedo).toBe(false);
  });

  it('case 9: undo 不动非 addedPartIds 的零件 (plate 不会被删，恢复到 prevPositions 范围内的 only pin)', () => {
    setupSnappedState();
    const plateBefore = { ...useStore.getState().parts.plate };
    useStore.getState().commitAxialSliding();
    useStore.getState().undo();
    // plate 保留位置（plate 不在 movedPartIds，没有 prevPositions 项）
    expect(useStore.getState().parts.plate).toEqual(plateBefore);
  });

  it('case 10: 不含 addedPartIds 的 SnapCommand round-trip 完全可逆 (重定位场景)', () => {
    // 模拟"已存在零件位置被 snap 重定位"场景（snap 不新增零件）
    useStore.setState({
      parts: {
        plate: { ldrawId: 'plate.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        pin:   { ldrawId: 'pin.dat',   position: [0.05, 0.02, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { plate: new Set(['pin']), pin: new Set(['plate']) },
      snapPreState: {
        movedPartIds: ['pin'],
        prevPositions: { pin: { position: [0.10, 0, 0], quaternion: [0, 0, 0, 1] } },
        addedConnections: [{ from: 'pin', to: 'plate' }],
        addedPartIds: [], // 关键：无新增零件
        addedPortKeys: [],
      },
    } as any);
    useStore.getState().commitAxialSliding();
    const posAfterCommit = useStore.getState().parts.pin.position;

    useStore.getState().undo();
    expect(useStore.getState().parts.pin.position).toEqual([0.10, 0, 0]); // 回到 prevPositions

    useStore.getState().redo();
    expect(useStore.getState().parts.pin.position).toEqual(posAfterCommit); // 恢复 nextPositions
  });

  it('case 11: 无 snapPreState 时 commit 不推 SnapCommand → undo 仍是更早的 op 或 no-op', () => {
    // snapPreState=null 时 commit 进 if (snapPreState) 短路，不 push
    useStore.setState({
      snapPreState: null,
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
    } as any);
    useStore.getState().commitAxialSliding();
    expect(useStore.getState().canUndo).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cmd+Z mid-snap（snap 已落未 commit）— undo 撤当前操作而非翻旧历史
// 修自用户反馈："Cmd+Z 不好用"。AXIAL_SLIDING 中 snapPreState 非空，该 snap
// 还没进 _history；此刻 undo 应 abort 当前 snap，而不是去 _history.undo() 翻更
// 早的已提交命令（否则旧操作被撤、当前 snap 还挂着，状态错位）。
// ─────────────────────────────────────────────────────────────────────────
describe('store.undo/redo — mid-snap（snapPreState 非空）拦截', () => {
  beforeEach(resetStore);

  function commitOnePinIntoHistory() {
    // 提交一个 snap 进历史（pin 落地 + cmd1），commit 后 snapPreState 被清。
    useStore.setState({
      parts: {
        plate: { ldrawId: 'plate.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        pin:   { ldrawId: 'pin.dat',   position: [0.05, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { plate: new Set(['pin']), pin: new Set(['plate']) },
      occupiedPorts: {},
      snapPreState: {
        movedPartIds: ['pin'],
        prevPositions: { pin: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } },
        addedConnections: [{ from: 'pin', to: 'plate' }],
        addedPartIds: ['pin'],
        addedPortKeys: [],
      },
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
    } as any);
    useStore.getState().commitAxialSliding();
  }

  function startLivePin2() {
    // 模拟用户又 snap 了 pin2，处于 AXIAL_SLIDING 未 commit（snapPreState 非空）。
    useStore.setState({
      parts: {
        ...useStore.getState().parts,
        pin2: { ldrawId: 'pin.dat', position: [0.1, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      snapPreState: {
        movedPartIds: ['pin2'],
        prevPositions: { pin2: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } },
        addedConnections: [{ from: 'pin2', to: 'plate' }],
        addedPartIds: ['pin2'],
        addedPortKeys: [],
      },
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
    } as any);
  }

  it('case 12: undo during live snap → abort 当前 snap（删 pin2 / 回 IDLE / 清 snapPreState），不动已提交历史', () => {
    commitOnePinIntoHistory();
    expect(useStore.getState().canUndo).toBe(true);
    startLivePin2();

    useStore.getState().undo(); // mid-slide Cmd+Z

    const s = useStore.getState();
    // 当前未提交 snap 被 abort
    expect(s.parts.pin2).toBeUndefined();
    expect(s.interactionPhase).toBe(InteractionPhase.IDLE);
    expect(s.snapPreState).toBeNull();
    // 关键：第一个已提交命令没被乱撤
    expect(s.parts.pin).toBeDefined();
    expect(s.canUndo).toBe(true);
  });

  it('case 13: abort 后再 undo（已 IDLE / 无 snapPreState）→ 正常撤第一个 commit（pin 删）', () => {
    commitOnePinIntoHistory();
    startLivePin2();
    useStore.getState().undo();                       // abort pin2
    expect(useStore.getState().snapPreState).toBeNull();
    useStore.getState().undo();                       // 走历史撤 cmd1
    expect(useStore.getState().parts.pin).toBeUndefined();
  });

  it('case 14: redo 在 snapPreState 非空时 no-op（不翻被 undo 的命令）', () => {
    commitOnePinIntoHistory();
    useStore.getState().undo();                        // 撤 cmd1（pin 删, canRedo=true）
    expect(useStore.getState().parts.pin).toBeUndefined();
    expect(useStore.getState().canRedo).toBe(true);
    // 起 live snap
    useStore.setState({
      snapPreState: { movedPartIds: [], prevPositions: {}, addedConnections: [], addedPartIds: [], addedPortKeys: [] },
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
    } as any);
    useStore.getState().redo();                        // 应 no-op
    // pin 没被 redo 重建，canRedo 仍 true（命令还在 redo 栈里）
    expect(useStore.getState().parts.pin).toBeUndefined();
    expect(useStore.getState().canRedo).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 已放置零件自由编辑：rotateSelectedGroup / translateSelectedGroup + undo
// ─────────────────────────────────────────────────────────────────────────
describe('store.rotateSelectedGroup / translateSelectedGroup — 整组变换 + undo', () => {
  beforeEach(resetStore);

  function setupConnectedPair() {
    // plate（primary）+ pin，已连接。selection 选中 plate。
    // plate 设为更大件 → pickBasePart 选中 plate 作「地基」(base===primary) →
    // moving 组 = 整个连通组，整组一起动（验证「选中地基件→整组动」语义 + undo）。
    useStore.setState({
      parts: {
        plate: { ldrawId: 'plate.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        pin:   { ldrawId: 'pin.dat',   position: [0.02, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      partCatalog: {
        'plate.dat': { bboxSize: [0.3, 0.01, 0.2] },   // 最大 → 地基
        'pin.dat':   { bboxSize: [0.002, 0.02, 0.002] },
      },
      connections: { plate: new Set(['pin']), pin: new Set(['plate']) },
      selection: { primaryId: 'plate', level: SelectionLevel.GROUP, allConnectedIds: ['plate', 'pin'], excludedIds: [] },
      interactionPhase: InteractionPhase.IDLE,
    } as any);
  }

  it('case 15: translateSelectedGroup 整组平移（选中地基件）+ 可 undo', async () => {
    setupConnectedPair();
    await useStore.getState().translateSelectedGroup([0.008, 0, 0]);
    let s = useStore.getState();
    // plate 是地基(===primary) → moving=整组 → primary + pin 都平移 +8mm
    expect(s.parts.plate.position[0]).toBeCloseTo(0.008, 6);
    expect(s.parts.pin.position[0]).toBeCloseTo(0.028, 6);
    expect(s.canUndo).toBe(true);
    // undo 还原
    useStore.getState().undo();
    s = useStore.getState();
    expect(s.parts.plate.position[0]).toBeCloseTo(0, 6);
    expect(s.parts.pin.position[0]).toBeCloseTo(0.02, 6);
  });

  it('case 16: rotateSelectedGroup 绕 Y 90° → pin 绕 plate 原点转 + 可 undo', () => {
    setupConnectedPair();
    useStore.getState().rotateSelectedGroup(Math.PI / 2);
    let s = useStore.getState();
    // 绕世界 Y 转 90°，pivot=plate(原点)：pin 从 (0.02,0,0) 转到 (0,0,-0.02) 或 (0,0,0.02)
    expect(Math.abs(s.parts.pin.position[0])).toBeLessThan(1e-6);
    expect(Math.abs(s.parts.pin.position[2])).toBeCloseTo(0.02, 6);
    // plate 原点不动（pivot）
    expect(s.parts.plate.position[0]).toBeCloseTo(0, 6);
    expect(s.canUndo).toBe(true);
    // undo 还原 pin 位置
    useStore.getState().undo();
    s = useStore.getState();
    expect(s.parts.pin.position[0]).toBeCloseTo(0.02, 6);
    expect(s.parts.pin.position[2]).toBeCloseTo(0, 6);
  });

  it('case 17: 无 selection.primaryId → rotate/translate no-op', async () => {
    useStore.setState({
      parts: { plate: { ldrawId: 'plate.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA } },
      selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
    } as any);
    useStore.getState().rotateSelectedGroup(Math.PI / 2);
    await useStore.getState().translateSelectedGroup([0.01, 0, 0]);
    const s = useStore.getState();
    expect(s.parts.plate.position).toEqual([0, 0, 0]);
    expect(s.canUndo).toBe(false);
  });

  it('case 18: 单个孤立零件（无连接）也能转/移', async () => {
    useStore.setState({
      parts: { solo: { ldrawId: 'p.dat', position: [0.05, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA } },
      connections: {},
      selection: { primaryId: 'solo', level: SelectionLevel.GROUP, allConnectedIds: ['solo'], excludedIds: [] },
      interactionPhase: InteractionPhase.IDLE,
    } as any);
    await useStore.getState().translateSelectedGroup([0, 0, 0.008]);
    expect(useStore.getState().parts.solo.position[2]).toBeCloseTo(0.008, 6);
  });

  // 回归保护：translateSelectedGroup 接入 _transformSelectedSubassembly 通道
  // （走跟 single 平移同一套 detachedEdges/relatch 计算）后，必须保住"整组动、
  // 内部连接不脱开"语义；且只动 primary 所在的连通组，独立组不受影响。
  // 触发该 fix 的 bug：原实现纯刚体平移、不走 _transformSelectedSubassembly，
  // 因此挪到对面组孔位也不会自动吸附建连；现在 relatch 通道接通，单测里
  // ensurePortGeom fetch 失败→端口空集→relatch 空跑，行为仍合法（不破连接）。
  it('case 18b: translateSelectedGroup 接入 helper 通道 — 内部连接保留、独立组不动', async () => {
    useStore.setState({
      parts: {
        // Group A（选中）：plateA + pinA 已连
        plateA: { ldrawId: 'plate.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        pinA:   { ldrawId: 'pin.dat',   position: [0.02, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        // Group B（不选）：plateB + pinB 已连，整体远离 A
        plateB: { ldrawId: 'plate.dat', position: [0.5, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        pinB:   { ldrawId: 'pin.dat',   position: [0.52, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      partCatalog: {
        'plate.dat': { bboxSize: [0.3, 0.01, 0.2] },
        'pin.dat':   { bboxSize: [0.002, 0.02, 0.002] },
      },
      connections: {
        plateA: new Set(['pinA']), pinA: new Set(['plateA']),
        plateB: new Set(['pinB']), pinB: new Set(['plateB']),
      },
      selection: { primaryId: 'plateA', level: SelectionLevel.GROUP, allConnectedIds: ['plateA', 'pinA'], excludedIds: [] },
      interactionPhase: InteractionPhase.IDLE,
    } as any);

    await useStore.getState().translateSelectedGroup([0, 0.008, 0]); // Q/E 路径：竖直上移

    const s = useStore.getState();
    // Group A 整组都动（plate=primary=地基 → moving=整组）
    expect(s.parts.plateA.position[1]).toBeCloseTo(0.008, 6);
    expect(s.parts.pinA.position[1]).toBeCloseTo(0.008, 6);
    // Group A 内部连接保留（baseIds=[] → 无界面可脱）
    expect(s.connections.plateA.has('pinA')).toBe(true);
    expect(s.connections.pinA.has('plateA')).toBe(true);
    // Group B 完全不动 + 连接保留（不属于 primary 所在 comp）
    expect(s.parts.plateB.position).toEqual([0.5, 0, 0]);
    expect(s.parts.pinB.position).toEqual([0.52, 0, 0]);
    expect(s.connections.plateB.has('pinB')).toBe(true);
    // Undo 链通
    expect(s.canUndo).toBe(true);
    useStore.getState().undo();
    const r = useStore.getState();
    expect(r.parts.plateA.position[1]).toBeCloseTo(0, 6);
    expect(r.parts.pinA.position[1]).toBeCloseTo(0, 6);
    expect(r.connections.plateA.has('pinA')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// addLog 连续相同消息折叠（×N）— 防过约束锁死等高频重复日志刷屏
// ─────────────────────────────────────────────────────────────────────────
describe('store.addLog — 连续相同消息折叠', () => {
  beforeEach(() => { useStore.setState({ logs: [] } as any); });

  it('case 19: 连续 3 条相同 message+type → 折叠成 1 条 count=3', () => {
    const add = useStore.getState().addLog;
    add('过约束锁死', 'ERROR');
    add('过约束锁死', 'ERROR');
    add('过约束锁死', 'ERROR');
    const logs = useStore.getState().logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].count).toBe(3);
    expect(logs[0].message).toBe('过约束锁死');
  });

  it('case 20: 不同 message 不折叠', () => {
    const add = useStore.getState().addLog;
    add('A', 'INFO');
    add('B', 'INFO');
    add('A', 'INFO');
    const logs = useStore.getState().logs;
    expect(logs).toHaveLength(3);
    expect(logs.every(l => l.count === undefined)).toBe(true);
  });

  it('case 21: 同 message 但不同 type 不折叠', () => {
    const add = useStore.getState().addLog;
    add('X', 'INFO');
    add('X', 'ERROR');
    expect(useStore.getState().logs).toHaveLength(2);
  });

  it('case 22: 折叠只看「末条」—— 被别的消息打断后再来同消息算新条目', () => {
    const add = useStore.getState().addLog;
    add('rot', 'ERROR');   // 1
    add('rot', 'ERROR');   // 折叠 → count 2
    add('moved', 'ACTION'); // 打断
    add('rot', 'ERROR');   // 新条目（末条是 moved，不折叠）
    const logs = useStore.getState().logs;
    expect(logs).toHaveLength(3);
    expect(logs[0].count).toBe(2);
    expect(logs[2].count).toBeUndefined();
  });
});

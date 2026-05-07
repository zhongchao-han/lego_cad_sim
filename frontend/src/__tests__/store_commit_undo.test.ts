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
import { ZoneType, InteractionPhase } from '../types';

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

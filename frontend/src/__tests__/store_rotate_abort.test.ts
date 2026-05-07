/**
 * store_rotate_abort.test.ts
 * ==========================
 * 审计 Round 2 - Top 1+3：rotateSelectedPart + abortCurrentInteraction
 *
 * rotateSelectedPart 是状态机最复杂的 0 单测函数，覆盖：
 *   - selectedPort/part 缺失短路
 *   - excludeId 优先级 (slidingTarget > 对偶面 occupiedPorts > 无)
 *   - 对偶面 anchor 容差查询 (TOL=0.02 LDU + 法线同轴 dot≈±1)
 *   - Case 4.1 过约束 v5 one-hop closure（overflow 锁死 + ERROR log）
 *   - applyGroupDelta 调用结果落进 parts
 *
 * abortCurrentInteraction 是 Esc 中断核心，覆盖：
 *   - snapPreState 完整回滚（addedPartIds 整零件 + addedConnections 双向 +
 *     addedPortKeys 端口占用 + prevPositions 恢复）
 *   - 无 snapPreState 时仍重置 phase 等
 *   - continuousPlacementSource 被清
 *
 * 不 mock axios（这两个 action 不打后端）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, portKey } from '../store';
import { ZoneType, InteractionPhase } from '../types';

const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number[], number[], number[]];

function makePort(partId: string, position: [number, number, number] = [0, 0, 0]) {
  return {
    partId,
    ldrawId: `${partId}.dat`,
    portType: 'peg.dat',
    position,
    rotation: EYE3,
    globalPos: position,
    globalQuat: [0, 0, 0, 1] as [number, number, number, number],
  };
}

function quatEq(a: number[], b: number[], tol = 1e-6) {
  return Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) - 1) < tol;
}

// ─────────────────────────────────────────────────────────────────────────
// rotateSelectedPart
// ─────────────────────────────────────────────────────────────────────────
describe('store.rotateSelectedPart', () => {
  beforeEach(() => {
    useStore.setState({
      parts: {},
      connections: {},
      occupiedPorts: {},
      selectedPort: null,
      slidingTarget: null,
      logs: [],
    } as any);
  });

  it('case 1: selectedPort=null → no-op (parts 不变)', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
    } as any);
    const before = JSON.stringify(useStore.getState().parts);
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    expect(JSON.stringify(useStore.getState().parts)).toBe(before);
  });

  it('case 2: part 不在 parts 字典 → no-op', () => {
    useStore.setState({
      selectedPort: makePort('GHOST') as any,
    } as any);
    expect(() => useStore.getState().rotateSelectedPart(Math.PI / 2)).not.toThrow();
    expect(useStore.getState().parts).toEqual({});
  });

  it('case 3: 孤岛单 part（无 connections / 无 slidingTarget / 无 occupiedPorts）→ 整 part 旋转，quaternion 变化', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      selectedPort: makePort('A') as any,
    } as any);
    const before = useStore.getState().parts.A.quaternion;
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    const after = useStore.getState().parts.A.quaternion;
    expect(quatEq(before, after)).toBe(false);
  });

  it('case 4: slidingTarget.partId 优先作为 excludeId — A↔B 链，选 A，target=B → srcGroup=[A]', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0.05, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { A: new Set(['B']), B: new Set(['A']) },
      selectedPort: makePort('A') as any,
      slidingTarget: makePort('B', [0.05, 0, 0]) as any,
    } as any);
    const bBefore = useStore.getState().parts.B.quaternion;
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    // B 是 anchor，纹丝不动
    expect(useStore.getState().parts.B.quaternion).toEqual(bBefore);
    // A 转了
    expect(quatEq([0, 0, 0, 1], useStore.getState().parts.A.quaternion)).toBe(false);
  });

  it('case 5: 对偶面 anchor 容差查询 — selectedPort 在 [0,0,0] Z+，occupiedPorts.A 含 [0.01,0,0]|Z- → 识别 anchor=B', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { A: new Set(['B']), B: new Set(['A']) },
      // selectedPort 在 (0,0,0) Z 正向；occupiedPorts.A 的 key 是 connhole 对偶面（位置 [0.01,0,0] Z 反向）
      occupiedPorts: {
        A: {
          // pos format: 'x.xxxx,y.yyyy,z.zzzz|nx.xx,ny.yy,nz.zz'
          '0.0100,0.0000,0.0000|0.00,0.00,-1.00': 'B',
        },
      },
      selectedPort: makePort('A', [0, 0, 0]) as any,
    } as any);
    const bBefore = useStore.getState().parts.B.quaternion;
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    // B 被识别为 anchor，不动
    expect(useStore.getState().parts.B.quaternion).toEqual(bBefore);
  });

  it('case 6: 对偶面 anchor 法线不同轴 (Z+ vs X+) → 不识别，anchor=none，整组旋转', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { A: new Set(['B']), B: new Set(['A']) },
      occupiedPorts: {
        A: {
          // 法线 X+ 与 selectedPort 的 Z+ 不同轴 (dot=0)
          '0.0100,0.0000,0.0000|1.00,0.00,0.00': 'B',
        },
      },
      selectedPort: makePort('A', [0, 0, 0]) as any,
    } as any);
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    // B 没被排除 → srcGroup=[A,B] 整组旋转 → B 的 quaternion 也变了
    expect(quatEq([0, 0, 0, 1], useStore.getState().parts.B.quaternion)).toBe(false);
  });

  it('case 7: 对偶面 anchor 距离超 TOL (0.05 > 0.02) → 不识别', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { A: new Set(['B']), B: new Set(['A']) },
      occupiedPorts: {
        A: {
          '0.0500,0.0000,0.0000|0.00,0.00,1.00': 'B', // 距离 0.05 > TOL 0.02
        },
      },
      selectedPort: makePort('A', [0, 0, 0]) as any,
    } as any);
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    // 不识别 → 整组旋转 → B 也变
    expect(quatEq([0, 0, 0, 1], useStore.getState().parts.B.quaternion)).toBe(false);
  });

  it('case 8: Case 4.1 过约束锁死 — A↔B, A↔C, C↔D 拓扑，选 A exclude=B，srcGroup=[A,C,D] 含非邻居 D → ERROR log + return', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        C: { ldrawId: 'C.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        D: { ldrawId: 'D.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: {
        A: new Set(['B', 'C']),
        B: new Set(['A']),
        C: new Set(['A', 'D']),
        D: new Set(['C']),
      },
      selectedPort: makePort('A') as any,
      slidingTarget: makePort('B') as any,
    } as any);
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    // 过约束触发 → A/C/D 都没动（return 提前退出）
    expect(useStore.getState().parts.A.quaternion).toEqual([0, 0, 0, 1]);
    expect(useStore.getState().parts.D.quaternion).toEqual([0, 0, 0, 1]);
    // log 含过约束关键字
    const errLogs = useStore.getState().logs.filter(l => l.type === 'ERROR');
    expect(errLogs.length).toBeGreaterThan(0);
    expect(errLogs[0].message).toContain('过约束锁死');
    expect(errLogs[0].message).toContain('D');
  });

  it('case 9: 叶子 anchor 不应误报过约束 — A↔B 单连，选 A exclude=B → srcGroup=[A] ⊆ {A,B} → 通过', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { A: new Set(['B']), B: new Set(['A']) },
      selectedPort: makePort('A') as any,
      slidingTarget: makePort('B') as any,
    } as any);
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    // A 转了
    expect(quatEq([0, 0, 0, 1], useStore.getState().parts.A.quaternion)).toBe(false);
    // B 没动
    expect(useStore.getState().parts.B.quaternion).toEqual([0, 0, 0, 1]);
    // 无 ERROR
    expect(useStore.getState().logs.filter(l => l.type === 'ERROR').length).toBe(0);
  });

  it('case 10: 旋转后 addLog 含 "Rotated part" 与 srcGroup 大小', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      selectedPort: makePort('A') as any,
    } as any);
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    const log = useStore.getState().logs.find(l => l.message.includes('Rotated part A'));
    expect(log).toBeDefined();
    expect(log!.message).toContain('group of 1');
    expect(log!.message).toContain('anchor=none');
  });

  it('case 11: portKey 格式 sanity — 用 portKey() 生成的 key 能被对偶面查询逻辑命中', () => {
    // 这是一个集成 sanity：rotateSelectedPart 用 substring split 解析 occupiedPorts key,
    // 必须跟 store::portKey 输出格式严格一致。如果 portKey 改格式（小数位 / 分隔符）
    // 这个 case 会立刻翻红。
    const k = portKey([0.01, 0, 0], EYE3 as any);
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { A: new Set(['B']), B: new Set(['A']) },
      occupiedPorts: { A: { [k]: 'B' } },
      selectedPort: makePort('A', [0, 0, 0]) as any,
    } as any);
    useStore.getState().rotateSelectedPart(Math.PI / 2);
    // 同轴（dot=1）+ 距离 0.01 < TOL 0.02 → B 被识别为 anchor → B 不动
    expect(useStore.getState().parts.B.quaternion).toEqual([0, 0, 0, 1]);
    // A 转了
    expect(quatEq([0, 0, 0, 1], useStore.getState().parts.A.quaternion)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// abortCurrentInteraction
// ─────────────────────────────────────────────────────────────────────────
describe('store.abortCurrentInteraction', () => {
  beforeEach(() => {
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
  });

  it('case 1: snapPreState=null 时不动 parts/connections，仍重置 phase', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [1, 2, 3], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      interactionPhase: InteractionPhase.SOURCE_LOCKED,
      selectedPort: makePort('A') as any,
    } as any);
    useStore.getState().abortCurrentInteraction();
    expect(useStore.getState().parts.A.position).toEqual([1, 2, 3]); // 没回滚（无 pre）
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
    expect(useStore.getState().selectedPort).toBeNull();
  });

  it('case 2: addedPartIds 整零件移除 + prevPositions 恢复', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [9, 9, 9], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        NEW_PIN: { ldrawId: 'pin.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      snapPreState: {
        movedPartIds: ['A'],
        prevPositions: { A: { position: [1, 1, 1], quaternion: [0, 0, 0, 1] } },
        addedConnections: [],
        addedPartIds: ['NEW_PIN'],
        addedPortKeys: [],
      },
    } as any);
    useStore.getState().abortCurrentInteraction();
    // NEW_PIN 应被删
    expect(useStore.getState().parts.NEW_PIN).toBeUndefined();
    // A 位置应回滚到 prevPositions
    expect(useStore.getState().parts.A.position).toEqual([1, 1, 1]);
  });

  it('case 3: addedConnections 双向 Set 删除，size==0 时 delete key', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { A: new Set(['B']), B: new Set(['A']) },
      snapPreState: {
        movedPartIds: ['A'],
        prevPositions: { A: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } },
        addedConnections: [{ from: 'A', to: 'B' }],
        addedPartIds: [],
        addedPortKeys: [],
      },
    } as any);
    useStore.getState().abortCurrentInteraction();
    const conns = useStore.getState().connections;
    // 双向都删干净；size 0 → key 也删
    expect(conns['A']).toBeUndefined();
    expect(conns['B']).toBeUndefined();
  });

  it('case 4: addedConnections 删除一条但 Set 仍非空 → 保留 key', () => {
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        C: { ldrawId: 'C.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      // A 已有 B、C 两个邻居，pre 仅记录新增了 A↔C
      connections: { A: new Set(['B', 'C']), B: new Set(['A']), C: new Set(['A']) },
      snapPreState: {
        movedPartIds: [],
        prevPositions: {},
        addedConnections: [{ from: 'A', to: 'C' }],
        addedPartIds: [],
        addedPortKeys: [],
      },
    } as any);
    useStore.getState().abortCurrentInteraction();
    const conns = useStore.getState().connections;
    expect(conns['A']?.has('B')).toBe(true);
    expect(conns['A']?.has('C')).toBe(false);
    expect(conns['B']?.has('A')).toBe(true);
    expect(conns['C']).toBeUndefined(); // 仅有 A 一个邻居，删后 size 0
  });

  it('case 5: addedPortKeys 删 occupiedPorts 内 key，最后一项时删 partId 整桶', () => {
    useStore.setState({
      occupiedPorts: {
        A: {
          'k1|n1': 'B',
          'k2|n2': 'C',
        },
        B: { 'kB|nB': 'A' },
      },
      snapPreState: {
        movedPartIds: [],
        prevPositions: {},
        addedConnections: [],
        addedPartIds: [],
        addedPortKeys: [
          { partId: 'A', key: 'k1|n1', peerId: 'B' },
          { partId: 'B', key: 'kB|nB', peerId: 'A' },
        ],
      },
    } as any);
    useStore.getState().abortCurrentInteraction();
    const occ = useStore.getState().occupiedPorts;
    // A 桶 k1 删了，k2 保留
    expect(occ['A']?.['k1|n1']).toBeUndefined();
    expect(occ['A']?.['k2|n2']).toBe('C');
    // B 桶最后一项被删 → 整桶清掉
    expect(occ['B']).toBeUndefined();
  });

  it('case 6: addedPartIds 的 occupiedPorts 整表删除', () => {
    useStore.setState({
      occupiedPorts: {
        OLD: { 'k|n': 'X' },
        NEW: { 'k|n': 'Y' },
      },
      snapPreState: {
        movedPartIds: [],
        prevPositions: {},
        addedConnections: [],
        addedPartIds: ['NEW'],
        addedPortKeys: [],
      },
    } as any);
    useStore.getState().abortCurrentInteraction();
    const occ = useStore.getState().occupiedPorts;
    expect(occ['NEW']).toBeUndefined();
    expect(occ['OLD']).toBeDefined();
  });

  it('case 7: 重置全部交互态（phase / selectedPort / hoveredPort / slidingTarget / slideOffset / snapPreState / continuousPlacementSource）', () => {
    useStore.setState({
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      selectedPort: makePort('A') as any,
      hoveredPort: makePort('B') as any,
      slidingTarget: makePort('C') as any,
      slideOffset: 5,
      snapPreState: null,
      continuousPlacementSource: makePort('D') as any,
    } as any);
    useStore.getState().abortCurrentInteraction();
    const s = useStore.getState();
    expect(s.interactionPhase).toBe(InteractionPhase.IDLE);
    expect(s.selectedPort).toBeNull();
    expect(s.hoveredPort).toBeNull();
    expect(s.slidingTarget).toBeNull();
    expect(s.slideOffset).toBe(0);
    expect(s.snapPreState).toBeNull();
    expect(s.continuousPlacementSource).toBeNull();
  });

  it('case 8: addLog 写入 "Aborting port interaction"', () => {
    useStore.getState().abortCurrentInteraction();
    const log = useStore.getState().logs.find(l => l.message.includes('Aborting port interaction'));
    expect(log).toBeDefined();
  });
});

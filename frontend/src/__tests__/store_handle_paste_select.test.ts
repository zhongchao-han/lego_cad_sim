/**
 * store_handle_paste_select.test.ts
 * =================================
 * 审计 Round 3-C — 三个状态机分支补遗：
 *   - handlePortClick：空场景首零件 / 同零件切源端口 / snap 失败回滚
 *   - pasteClipboard：多零件包围盒中心归零（粘贴幽灵居中于鼠标）
 *   - selectPart：append=true toggle 语义 + level=PART vs GROUP
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { useStore } from '../store';
import { ZoneType, InteractionPhase, SelectionLevel } from '../types';

vi.mock('axios');
const mockAxios = vi.mocked(axios);

const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number[], number[], number[]];

function makePort(partId: string, ldrawId?: string, portType: string = 'peg.dat') {
  return {
    partId,
    ldrawId: ldrawId ?? `${partId}.dat`,
    portType,
    position: [0, 0, 0] as [number, number, number],
    rotation: EYE3,
    globalPos: [0, 0, 0] as [number, number, number],
    globalQuat: [0, 0, 0, 1] as [number, number, number, number],
  };
}

function resetStore() {
  // 清 _history（跨 test 污染）
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
    clipboard: [],
    selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
    logs: [],
  } as any);
}

// ─────────────────────────────────────────────────────────────────────────
// handlePortClick — 三个补遗分支
// ─────────────────────────────────────────────────────────────────────────
describe('store.handlePortClick — 补遗分支', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockAxios.post as any).mockResolvedValue({ data: { status: 'success', auto_latched_count: 0 } });
    resetStore();
  });

  it('case 1: 空场景首零件 (activeParts.length===0 + IDLE) → 直接落 part 到 [0,0,0] + selectedPort=null', async () => {
    // 起始 parts 为空，phase=IDLE
    const port = { ...makePort('first_pin'), ldrawId: '2780.dat' };
    await useStore.getState().handlePortClick(port as any);

    const s = useStore.getState();
    // part 直接落盘 (instanceId = port.partId)
    expect(s.parts['first_pin']).toBeDefined();
    expect(s.parts['first_pin'].position).toEqual([0, 0, 0]);
    expect(s.parts['first_pin'].zone).toBe(ZoneType.ACTIVE_ARENA);
    expect(s.parts['first_pin'].ldrawId).toBe('2780.dat');
    // 状态：IDLE + selectedPort=null + previewPartId=null
    expect(s.interactionPhase).toBe(InteractionPhase.IDLE);
    expect(s.selectedPort).toBeNull();
  });

  it('case 2: PREVIEWING + 空 active → 也走"首零件"分支', async () => {
    useStore.setState({
      interactionPhase: InteractionPhase.PREVIEWING,
      previewPartId: '2780.dat',
    } as any);
    await useStore.getState().handlePortClick(
      { ...makePort('p2'), ldrawId: '2780.dat' } as any
    );
    expect(useStore.getState().parts['p2']).toBeDefined();
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
  });

  it('case 3: SOURCE_LOCKED + 同 partId 切源端口 → 仅切换 selectedPort 不进 snap', async () => {
    useStore.setState({
      parts: {
        plate: { ldrawId: 'plate.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      selectedPort: makePort('plate', 'plate.dat', 'peghole.0') as any,
      interactionPhase: InteractionPhase.SOURCE_LOCKED,
    } as any);

    // 同 partId 不同 portType
    const newPortOnSamePart = makePort('plate', 'plate.dat', 'peghole.1');
    await useStore.getState().handlePortClick(newPortOnSamePart as any);

    const s = useStore.getState();
    // selectedPort 应已切到新 portType
    expect(s.selectedPort?.portType).toBe('peghole.1');
    // phase 仍 SOURCE_LOCKED（没进 snap）
    expect(s.interactionPhase).toBe(InteractionPhase.SOURCE_LOCKED);
    // axios 未被调用（snap 没触发）
    expect(mockAxios.post).not.toHaveBeenCalled();
    // log 含 "switching source"
    const log = useStore.getState().logs.find(l => l.message.includes('switching source'));
    expect(log).toBeDefined();
  });

  it('case 4: SOURCE_LOCKED + snap 失败 (target 不在 ACTIVE_ARENA) → 回滚到 IDLE + selectedPort=null', async () => {
    // target zone=STAGED → snapParts 在 L660 return false
    useStore.setState({
      parts: {
        src:    { ldrawId: 'src.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        target: { ldrawId: 'target.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.STAGED },
      },
      selectedPort: makePort('src') as any,
      interactionPhase: InteractionPhase.SOURCE_LOCKED,
    } as any);

    await useStore.getState().handlePortClick(makePort('target') as any);

    const s = useStore.getState();
    expect(s.interactionPhase).toBe(InteractionPhase.IDLE);
    expect(s.selectedPort).toBeNull();
    // log 含 SNAP FAILED
    const log = useStore.getState().logs.find(l => l.message.includes('Snap FAILED'));
    expect(log).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pasteClipboard — 多零件包围盒中心归零
// ─────────────────────────────────────────────────────────────────────────
describe('store.pasteClipboard — 多零件中心归零', () => {
  beforeEach(resetStore);

  it('case 5: 单零件 paste → position 归零（中心 = 自身位置 → 减后 [0,0,0]）', () => {
    useStore.setState({
      clipboard: [{
        id: 'a',
        state: { ldrawId: 'a.dat', position: [5, 7, 9], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      }],
    } as any);
    useStore.getState().pasteClipboard();
    const payload = useStore.getState().freePlacingPayload;
    expect(payload.length).toBe(1);
    expect(payload[0].state.position).toEqual([0, 0, 0]);
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.FREE_PLACING);
  });

  it('case 6: 三零件对称 paste → 几何中心归零，相对位置保持', () => {
    useStore.setState({
      clipboard: [
        { id: 'a', state: { ldrawId: 'a.dat', position: [-1, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA } },
        { id: 'b', state: { ldrawId: 'b.dat', position: [0, 0, 0],  quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA } },
        { id: 'c', state: { ldrawId: 'c.dat', position: [1, 0, 0],  quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA } },
      ],
    } as any);
    useStore.getState().pasteClipboard();
    const payload = useStore.getState().freePlacingPayload;
    // 中心 = (0,0,0)，减后位置不变
    expect(payload.map(p => p.state.position[0])).toEqual([-1, 0, 1]);
  });

  it('case 7: 偏离原点的 cluster paste → 中心被减为零，相对偏移保持', () => {
    useStore.setState({
      clipboard: [
        { id: 'a', state: { ldrawId: 'a.dat', position: [10, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA } },
        { id: 'b', state: { ldrawId: 'b.dat', position: [12, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA } },
      ],
    } as any);
    useStore.getState().pasteClipboard();
    const payload = useStore.getState().freePlacingPayload;
    // 中心 = 11，减后 [-1, 1]
    expect(payload[0].state.position).toEqual([-1, 0, 0]);
    expect(payload[1].state.position).toEqual([1, 0, 0]);
  });

  it('case 8: 空 clipboard → no-op，不进 FREE_PLACING', () => {
    useStore.setState({ clipboard: [] } as any);
    useStore.getState().pasteClipboard();
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
  });

  it('case 9: paste 后 newId 是 ldrawId base + UUID 后缀（不与原 id 冲突）', () => {
    useStore.setState({
      clipboard: [{
        id: 'origin_xxxxxxxx',
        state: { ldrawId: '2780.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      }],
    } as any);
    useStore.getState().pasteClipboard();
    const payload = useStore.getState().freePlacingPayload;
    // newId 形如 "origin_xxxxxxxx" → split('_')[0] = "origin" + UUID
    expect(payload[0].id).toMatch(/^origin_[a-f0-9]{8}$/);
    expect(payload[0].id).not.toBe('origin_xxxxxxxx');
  });

  it('case 10: 复制连通组 → 粘贴保留组内连接 + 占用（remap 到新 id），commit 后副本互连', () => {
    // a—b 互连 + 互相占用端口；选中两者复制
    useStore.setState({
      parts: {
        a: { ldrawId: 'a.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        b: { ldrawId: 'b.dat', position: [0.02, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { a: new Set(['b']), b: new Set(['a']) },
      occupiedPorts: { a: { 'kA': 'b' }, b: { 'kB': 'a' } },
      selection: { primaryId: 'a', level: SelectionLevel.GROUP, allConnectedIds: ['a', 'b'], excludedIds: [] },
    } as any);

    useStore.getState().copySelected();
    useStore.getState().pasteClipboard();

    const meta = (useStore.getState() as any).freePlacingMeta;
    const payload = useStore.getState().freePlacingPayload;
    const [nA, nB] = payload.map(p => p.id);
    // meta 里有 1 条组内连接（remap 到新 id）+ 双侧占用 remap 到新 peer
    expect(meta.connections.length).toBe(1);
    const edge = meta.connections[0];
    expect([edge.from, edge.to].sort()).toEqual([nA, nB].sort());
    expect(meta.occupied[nA]?.['kA']).toBe(nB);
    expect(meta.occupied[nB]?.['kB']).toBe(nA);

    // commit（落点放原点）→ 新副本应互连 + 占用就位
    const finalStates: Record<string, any> = {};
    payload.forEach(p => { finalStates[p.id] = { ...p.state }; });
    useStore.getState().commitFreePlacing(finalStates);

    const st = useStore.getState();
    expect(st.connections[nA]?.has(nB)).toBe(true);
    expect(st.connections[nB]?.has(nA)).toBe(true);
    expect(st.occupiedPorts[nA]?.['kA']).toBe(nB);
    // 原件连接不受影响
    expect(st.connections['a']?.has('b')).toBe(true);

    // undo 应同时撤销副本的零件 + 连接
    useStore.getState().undo();
    const st2 = useStore.getState();
    expect(st2.parts[nA]).toBeUndefined();
    expect(st2.connections[nA]).toBeUndefined();
  });

  it('case 11: 复制有连接的多件 → 日志提示「含 N 个组内连接」', () => {
    useStore.setState({
      parts: {
        a: { ldrawId: 'a.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        b: { ldrawId: 'b.dat', position: [0.02, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: { a: new Set(['b']), b: new Set(['a']) },
      selection: { primaryId: 'a', level: SelectionLevel.GROUP, allConnectedIds: ['a', 'b'], excludedIds: [] },
    } as any);
    useStore.getState().copySelected();
    const log = useStore.getState().logs.find(l => l.message.startsWith('Copied 2 parts'));
    expect(log?.message).toContain('含 1 个组内连接');
  });

  it('case 12: 复制互不相连的多件 → 日志提示是散件（根因可见）', () => {
    useStore.setState({
      parts: {
        a: { ldrawId: 'a.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        b: { ldrawId: 'b.dat', position: [50, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: {},
      selection: { primaryId: 'a', level: SelectionLevel.GROUP, allConnectedIds: ['a', 'b'], excludedIds: [] },
    } as any);
    useStore.getState().copySelected();
    const log = useStore.getState().logs.find(l => l.message.startsWith('Copied 2 parts'));
    expect(log?.message).toContain('无端口连接');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// selectPart — append/level
// ─────────────────────────────────────────────────────────────────────────
describe('store.selectPart — append toggle + level=PART/GROUP', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({
      parts: {
        A: { ldrawId: 'A.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        B: { ldrawId: 'B.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
        C: { ldrawId: 'C.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 7, zone: ZoneType.ACTIVE_ARENA },
      },
      // A↔B 一组，C 独立岛
      connections: { A: new Set(['B']), B: new Set(['A']) },
    } as any);
  });

  it('case 10: level=GROUP 选 A → allConnectedIds 含连通组 [A,B]', () => {
    useStore.getState().selectPart('A', SelectionLevel.GROUP);
    const ids = useStore.getState().selection.allConnectedIds.sort();
    expect(ids).toEqual(['A', 'B']);
    expect(useStore.getState().selection.primaryId).toBe('A');
  });

  it('case 11: level=INDIVIDUAL (非 GROUP) 选 A → allConnectedIds 仅 [A]', () => {
    useStore.getState().selectPart('A', SelectionLevel.INDIVIDUAL);
    expect(useStore.getState().selection.allConnectedIds).toEqual(['A']);
  });

  it('case 12: append=true + 选当前未在 selection 的 C → 加入', () => {
    // 先选 A (含组 A,B)
    useStore.getState().selectPart('A', SelectionLevel.GROUP);
    // append C
    useStore.getState().selectPart('C', SelectionLevel.GROUP, true);
    const ids = useStore.getState().selection.allConnectedIds.sort();
    expect(ids).toEqual(['A', 'B', 'C']);
    // primaryId = allConnectedIds 末尾
    expect(useStore.getState().selection.primaryId).toBe('C');
  });

  it('case 13: append=true 已全在 selection → toggle 移除', () => {
    // 选 A 含 A,B
    useStore.getState().selectPart('A', SelectionLevel.GROUP);
    // append A 自己 (level=GROUP newIds=[A,B] 都已在) → toggle 移除
    useStore.getState().selectPart('A', SelectionLevel.GROUP, true);
    expect(useStore.getState().selection.allConnectedIds).toEqual([]);
  });

  it('case 14: append=false 默认覆盖 selection (前一个被丢弃)', () => {
    useStore.getState().selectPart('A', SelectionLevel.GROUP);
    useStore.getState().selectPart('C', SelectionLevel.GROUP); // 默认 append=false
    expect(useStore.getState().selection.allConnectedIds).toEqual(['C']);
    expect(useStore.getState().selection.primaryId).toBe('C');
  });
});

/**
 * freePorts.test.ts
 * =================
 * computeFreePorts / computeAssemblyFreePorts 派生视图单测。
 *
 * 走法 A 期 A1 — 测纯函数,不需要 React render。
 */

import { describe, it, expect } from 'vitest';
import { computeFreePorts, computeAssemblyFreePorts, countAssemblyFreePortsCheap } from '../utils/freePorts';
import type { LDrawSite, LDrawPort } from '../useLDrawPart';
import { portKey } from '../store';
import { ZoneType, type Mat3 } from '../types';

// LDrawPort.rotation 是 number[][]，跟 Mat3 (固定 3x3 元组) 形状兼容但类型不同。
// 用 number[][] 避免赋值时类型 narrowing 警告，portKey 调用点 cast 成 Mat3。
const EYE3: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function makePort(name: string, position: [number, number, number]): LDrawPort {
  return {
    name,
    type: 'peg.dat',
    position,
    rotation: EYE3,
  };
}

function makeSite(id: string, ports: LDrawPort[]): LDrawSite {
  return {
    id,
    position: ports[0]?.position ?? [0, 0, 0],
    occupied_by: null,
    ports,
  };
}

describe('computeFreePorts', () => {
  it('case 1: empty sites → empty result', () => {
    expect(computeFreePorts([], {})).toEqual([]);
  });

  it('case 2: 全无 occupied → 所有 port 都 free', () => {
    const sites = [
      makeSite('s1', [makePort('p1', [0, 0, 0]), makePort('p2', [0.01, 0, 0])]),
      makeSite('s2', [makePort('p3', [0.02, 0, 0])]),
    ];
    const free = computeFreePorts(sites, {});
    expect(free.length).toBe(3);
    expect(free.map(f => f.port.name)).toEqual(['p1', 'p2', 'p3']);
    expect(free.map(f => f.siteId)).toEqual(['s1', 's1', 's2']);
  });

  it('case 3: 部分 occupied → 排除已占的,保留未占的', () => {
    const port1 = makePort('p1', [0, 0, 0]);
    const port2 = makePort('p2', [0.01, 0, 0]);
    const sites = [makeSite('s1', [port1, port2])];
    // p1 被占
    const occupied = { [portKey(port1.position, EYE3)]: 'peerPart' };
    const free = computeFreePorts(sites, occupied);
    expect(free.length).toBe(1);
    expect(free[0].port.name).toBe('p2');
  });

  it('case 4: 同 site 两 port 一个 occupied 一个不 → 仅返没占的', () => {
    const portFront = { ...makePort('front', [0, 0, 0]), rotation: EYE3 };
    // 同位置 z+ vs z- 法线区分
    const portBack: LDrawPort = {
      name: 'back',
      type: 'peg.dat',
      position: [0, 0, 0],
      rotation: [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
    };
    const sites = [makeSite('connhole_dual', [portFront, portBack])];
    // 只占 front 那面
    const occupied = { [portKey(portFront.position, portFront.rotation as Mat3)]: 'peer' };
    const free = computeFreePorts(sites, occupied);
    // front 被占,back 仍 free
    expect(free.length).toBe(1);
    expect(free[0].port.name).toBe('back');
  });

  it('case 5: 全部 occupied → 空数组', () => {
    const port1 = makePort('p1', [0, 0, 0]);
    const port2 = makePort('p2', [0.01, 0, 0]);
    const sites = [makeSite('s1', [port1, port2])];
    const occupied = {
      [portKey(port1.position, EYE3)]: 'peerA',
      [portKey(port2.position, EYE3)]: 'peerB',
    };
    expect(computeFreePorts(sites, occupied)).toEqual([]);
  });

  it('case 6: occupiedKeys 含图中不存在的 key（漂浮 / stale 残留）→ 不影响 free 计算', () => {
    const port1 = makePort('p1', [0, 0, 0]);
    const sites = [makeSite('s1', [port1])];
    // ghostKey 在 sites 里没有对应 port
    const occupied = { 'ghost_key|0.00,0.00,1.00': 'phantom_peer' };
    const free = computeFreePorts(sites, occupied);
    // p1 仍 free（ghostKey 不命中 portKey(p1)）
    expect(free.length).toBe(1);
    expect(free[0].port.name).toBe('p1');
  });

  it('case 7: 顺序保留 — sites 数组 + 各 site.ports 数组顺序', () => {
    const sites = [
      makeSite('s_z', [makePort('z1', [0, 0, 0]), makePort('z2', [0.01, 0, 0])]),
      makeSite('s_a', [makePort('a1', [0.02, 0, 0])]),
    ];
    const free = computeFreePorts(sites, {});
    expect(free.map(f => f.port.name)).toEqual(['z1', 'z2', 'a1']);
  });
});

describe('computeAssemblyFreePorts', () => {
  it('case 8: 空装配 → 空 dict', () => {
    expect(computeAssemblyFreePorts({}, {})).toEqual({});
  });

  it('case 9: 多 part 聚合 — 各自只算自己的 occupied', () => {
    const sitesA = [makeSite('sa', [makePort('a1', [0, 0, 0])])];
    const sitesB = [makeSite('sb', [makePort('b1', [0, 0, 0])])];
    const partsWithSites = { partA: sitesA, partB: sitesB };
    // partA.a1 被占
    const allOccupied = {
      partA: { [portKey([0, 0, 0], EYE3)]: 'partB' },
    };
    const result = computeAssemblyFreePorts(partsWithSites, allOccupied);
    // partA 全占了,不在结果里;partB 全 free
    expect(Object.keys(result)).toEqual(['partB']);
    expect(result.partB.length).toBe(1);
    expect(result.partB[0].port.name).toBe('b1');
  });

  it('case 10: 排除 freePorts 为空的 part(整零件已"插满")', () => {
    const port1 = makePort('p1', [0, 0, 0]);
    const partsWithSites = { full: [makeSite('s', [port1])] };
    const allOccupied = { full: { [portKey(port1.position, EYE3)]: 'peer' } };
    const result = computeAssemblyFreePorts(partsWithSites, allOccupied);
    expect(result).toEqual({});
  });

  it('case 11: occupiedPorts 字段 partId 不存在 → 等价于无 occupied', () => {
    const port1 = makePort('p1', [0, 0, 0]);
    const partsWithSites = { ghost: [makeSite('s', [port1])] };
    const allOccupied = {}; // ghost 完全未在 store
    const result = computeAssemblyFreePorts(partsWithSites, allOccupied);
    expect(result.ghost.length).toBe(1);
  });
});

describe('countAssemblyFreePortsCheap', () => {
  it('case 12: 空装配 → 0', () => {
    expect(countAssemblyFreePortsCheap({}, {}, {}, ZoneType.ACTIVE_ARENA)).toBe(0);
  });

  it('case 13: 单 part 无 occupied → portCount', () => {
    const parts = { p1: { ldrawId: 'A.dat', zone: ZoneType.ACTIVE_ARENA } };
    const catalog = { 'A.dat': { portCount: 8 } };
    expect(countAssemblyFreePortsCheap(parts, catalog, {}, ZoneType.ACTIVE_ARENA)).toBe(8);
  });

  it('case 14: 部分 occupied → portCount - 占用数', () => {
    const parts = { p1: { ldrawId: 'A.dat', zone: ZoneType.ACTIVE_ARENA } };
    const catalog = { 'A.dat': { portCount: 8 } };
    const occupied = { p1: { 'k1|n1': 'peer', 'k2|n2': 'peer' } };
    expect(countAssemblyFreePortsCheap(parts, catalog, occupied, ZoneType.ACTIVE_ARENA)).toBe(6);
  });

  it('case 15: 占用数超 portCount → clamp 0 (不返负数)', () => {
    // 极端 corner：data 不一致情况下 occupiedPorts 比 portCount 多
    const parts = { p1: { ldrawId: 'A.dat', zone: ZoneType.ACTIVE_ARENA } };
    const catalog = { 'A.dat': { portCount: 2 } };
    const occupied = { p1: { 'k1|n1': 'a', 'k2|n2': 'b', 'k3|n3': 'c' } };
    expect(countAssemblyFreePortsCheap(parts, catalog, occupied, ZoneType.ACTIVE_ARENA)).toBe(0);
  });

  it('case 16: 非 ACTIVE_ARENA 零件被排除 (PREVIEW 不计入)', () => {
    const parts = {
      p1: { ldrawId: 'A.dat', zone: ZoneType.ACTIVE_ARENA },
      p2: { ldrawId: 'A.dat', zone: ZoneType.PREVIEW },
    };
    const catalog = { 'A.dat': { portCount: 4 } };
    expect(countAssemblyFreePortsCheap(parts, catalog, {}, ZoneType.ACTIVE_ARENA)).toBe(4);
  });

  it('case 17: partCatalog 缺失该 ldrawId → 跳过该 part 不计数', () => {
    const parts = {
      p1: { ldrawId: 'KNOWN.dat', zone: ZoneType.ACTIVE_ARENA },
      p2: { ldrawId: 'UNKNOWN.dat', zone: ZoneType.ACTIVE_ARENA }, // catalog 没
    };
    const catalog = { 'KNOWN.dat': { portCount: 3 } };
    expect(countAssemblyFreePortsCheap(parts, catalog, {}, ZoneType.ACTIVE_ARENA)).toBe(3);
  });

  it('case 18: 多 part 求和', () => {
    const parts = {
      p1: { ldrawId: 'A.dat', zone: ZoneType.ACTIVE_ARENA },
      p2: { ldrawId: 'B.dat', zone: ZoneType.ACTIVE_ARENA },
    };
    const catalog = {
      'A.dat': { portCount: 4 },
      'B.dat': { portCount: 6 },
    };
    const occupied = { p1: { 'k|n': 'p2' }, p2: { 'kk|nn': 'p1' } };
    // p1: 4-1=3, p2: 6-1=5, total=8
    expect(countAssemblyFreePortsCheap(parts, catalog, occupied, ZoneType.ACTIVE_ARENA)).toBe(8);
  });
});

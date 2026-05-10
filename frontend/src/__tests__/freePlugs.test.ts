/**
 * freePlugs.test.ts
 * =================
 * computeFreePlugs / computeAssemblyFreePlugs 派生视图单测。
 *
 * 走法 A 期 A2 — 测纯函数，无 React render。
 * 关键契约：plug 不锁 atomicity，partial 占用合法 → status 三态。
 */

import { describe, it, expect } from 'vitest';
import {
  computeFreePlugs,
  computeAssemblyFreePlugs,
  countAssemblyFreePlugsCheap,
  countAssemblyTotalPlugsCheap,
} from '../utils/freePlugs';
import type { LDrawSite, LDrawPort, LDrawPlug } from '../useLDrawPart';
import { portKey } from '../store';
import { ZoneType, type Mat3 } from '../types';

const EYE3: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function makePort(name: string, position: [number, number, number]): LDrawPort {
  return { name, type: 'stud.dat', position, rotation: EYE3 };
}

function makeSite(id: string, ports: LDrawPort[]): LDrawSite {
  return {
    id,
    position: ports[0]?.position ?? [0, 0, 0],
    occupied_by: null,
    ports,
  };
}

function makePlug(
  plugId: string,
  members: Array<[string, number]>,
  overrides: Partial<LDrawPlug> = {},
): LDrawPlug {
  return {
    plug_id: plugId,
    label: 'top_studs',
    gender: 'MALE',
    profile: 'STUD',
    direction: [0, 1, 0],
    members,
    port_count: members.length,
    site_ids: [...new Set(members.map(([s]) => s))].sort(),
    ...overrides,
  };
}

describe('computeFreePlugs', () => {
  it('case 1: empty plugs → empty result', () => {
    expect(computeFreePlugs([], [], {})).toEqual([]);
  });

  it('case 2: 全无 occupied → 单 plug 状态 free', () => {
    const ports = [makePort('p0', [0, 0, 0]), makePort('p1', [0.01, 0, 0])];
    const sites = [makeSite('s0', ports)];
    const plugs = [makePlug('plug_0', [['s0', 0], ['s0', 1]])];
    const result = computeFreePlugs(sites, plugs, {});
    expect(result.length).toBe(1);
    expect(result[0].status).toBe('free');
    expect(result[0].freePortCount).toBe(2);
    expect(result[0].totalPortCount).toBe(2);
    expect(result[0].freePortKeys.length).toBe(2);
  });

  it('case 3: 部分 occupied → status partial', () => {
    const port0 = makePort('p0', [0, 0, 0]);
    const port1 = makePort('p1', [0.01, 0, 0]);
    const sites = [makeSite('s0', [port0, port1])];
    const plugs = [makePlug('plug_0', [['s0', 0], ['s0', 1]])];
    const occupied = { [portKey(port0.position, EYE3)]: 'peer' };
    const result = computeFreePlugs(sites, plugs, occupied);
    expect(result.length).toBe(1);
    expect(result[0].status).toBe('partial');
    expect(result[0].freePortCount).toBe(1);
    expect(result[0].totalPortCount).toBe(2);
    expect(result[0].freePortKeys).toEqual([portKey(port1.position, EYE3 as Mat3)]);
  });

  it('case 4: 全占 → status full', () => {
    const port0 = makePort('p0', [0, 0, 0]);
    const port1 = makePort('p1', [0.01, 0, 0]);
    const sites = [makeSite('s0', [port0, port1])];
    const plugs = [makePlug('plug_0', [['s0', 0], ['s0', 1]])];
    const occupied = {
      [portKey(port0.position, EYE3)]: 'a',
      [portKey(port1.position, EYE3)]: 'b',
    };
    const result = computeFreePlugs(sites, plugs, occupied);
    expect(result[0].status).toBe('full');
    expect(result[0].freePortCount).toBe(0);
    expect(result[0].freePortKeys).toEqual([]);
  });

  it('case 5: 多 plug — 顶 stud 全 free + 底 tube 全占 → free + full 混合', () => {
    // 模拟 2x4 plate：顶 stud + 底 tube 各 2 plug
    const topPorts = [makePort('t0', [0, 0.004, 0]), makePort('t1', [0.008, 0.004, 0])];
    const botPorts = [makePort('b0', [0, -0.004, 0]), makePort('b1', [0.008, -0.004, 0])];
    const sites = [
      makeSite('s_top', topPorts),
      makeSite('s_bot', botPorts),
    ];
    const plugs = [
      makePlug('plug_top', [['s_top', 0], ['s_top', 1]], { label: 'top_studs', direction: [0, 1, 0] }),
      makePlug('plug_bot', [['s_bot', 0], ['s_bot', 1]], { label: 'bottom_studs', direction: [0, -1, 0] }),
    ];
    const occupied = {
      [portKey(botPorts[0].position, EYE3)]: 'peer',
      [portKey(botPorts[1].position, EYE3)]: 'peer',
    };
    const result = computeFreePlugs(sites, plugs, occupied);
    expect(result.length).toBe(2);
    expect(result[0].status).toBe('free');
    expect(result[1].status).toBe('full');
  });

  it('case 6: 跨 site plug（贯通孔合并）— 双面 port 任一占用都算 partial', () => {
    const portFront = makePort('front', [0, 0, 0]);
    const portBack: LDrawPort = {
      name: 'back', type: 'peghole.dat',
      position: [0, 0, 0], rotation: [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
    };
    const sites = [
      makeSite('s_front', [portFront]),
      makeSite('s_back', [portBack]),
    ];
    // 单 plug 跨两 site
    const plugs = [makePlug(
      'plug_through',
      [['s_front', 0], ['s_back', 0]],
      { gender: 'FEMALE', profile: 'CYL' },
    )];
    const occupied = { [portKey(portFront.position, portFront.rotation as Mat3)]: 'pin' };
    const result = computeFreePlugs(sites, plugs, occupied);
    expect(result[0].status).toBe('partial');
    expect(result[0].freePortCount).toBe(1);
    expect(result[0].freePortKeys[0]).toBe(portKey(portBack.position, portBack.rotation as Mat3));
  });

  it('case 7: occupiedKeys 含 stale ghost key → 不影响 plug 状态', () => {
    const port0 = makePort('p0', [0, 0, 0]);
    const sites = [makeSite('s0', [port0])];
    const plugs = [makePlug('plug_0', [['s0', 0]])];
    const occupied = { 'ghost|0,0,1': 'phantom' };
    const result = computeFreePlugs(sites, plugs, occupied);
    expect(result[0].status).toBe('free');
    expect(result[0].freePortCount).toBe(1);
  });

  it('case 8: 顺序保留 — 跟 plugs 数组顺序一致', () => {
    const sites = [makeSite('s0', [
      makePort('p0', [0, 0, 0]),
      makePort('p1', [0.01, 0, 0]),
      makePort('p2', [0.02, 0, 0]),
    ])];
    const plugs = [
      makePlug('z_plug', [['s0', 2]]),
      makePlug('a_plug', [['s0', 0]]),
      makePlug('m_plug', [['s0', 1]]),
    ];
    const result = computeFreePlugs(sites, plugs, {});
    expect(result.map(r => r.plug.plug_id)).toEqual(['z_plug', 'a_plug', 'm_plug']);
  });
});

describe('computeAssemblyFreePlugs', () => {
  it('case 9: 空装配 → 空 dict', () => {
    expect(computeAssemblyFreePlugs({}, {})).toEqual({});
  });

  it('case 10: 多 part 聚合 — 各自只算自己的 occupied', () => {
    const sitesA = [makeSite('sa', [makePort('a0', [0, 0, 0])])];
    const plugsA = [makePlug('A_plug', [['sa', 0]])];
    const sitesB = [makeSite('sb', [makePort('b0', [0, 0, 0])])];
    const plugsB = [makePlug('B_plug', [['sb', 0]])];
    const partsMeta = {
      partA: { sites: sitesA, plugs: plugsA },
      partB: { sites: sitesB, plugs: plugsB },
    };
    // partA 的 plug 占住，partB 完全 free
    const occupied = {
      partA: { [portKey([0, 0, 0], EYE3)]: 'partB' },
    };
    const result = computeAssemblyFreePlugs(partsMeta, occupied);
    expect(Object.keys(result).sort()).toEqual(['partA', 'partB']);
    expect(result.partA[0].status).toBe('full');
    expect(result.partB[0].status).toBe('free');
  });

  it('case 11: 排除 plugs 为空的 part（装饰类 0 plug）', () => {
    const partsMeta = {
      decorative: { sites: [], plugs: [] },
      real: {
        sites: [makeSite('s0', [makePort('p0', [0, 0, 0])])],
        plugs: [makePlug('plug_0', [['s0', 0]])],
      },
    };
    const result = computeAssemblyFreePlugs(partsMeta, {});
    expect(Object.keys(result)).toEqual(['real']);
  });

  it('case 12: occupiedPorts 字段 partId 不存在 → 等价于无 occupied', () => {
    const partsMeta = {
      ghost: {
        sites: [makeSite('s0', [makePort('p0', [0, 0, 0])])],
        plugs: [makePlug('plug_0', [['s0', 0]])],
      },
    };
    const result = computeAssemblyFreePlugs(partsMeta, {});
    expect(result.ghost[0].status).toBe('free');
  });
});

describe('countAssemblyTotalPlugsCheap', () => {
  it('case 13: 空装配 → 0', () => {
    expect(countAssemblyTotalPlugsCheap({}, {}, ZoneType.ACTIVE_ARENA)).toBe(0);
  });

  it('case 14: 单 part — 返 plugCount', () => {
    const parts = { p1: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA } };
    const catalog = { '170.dat': { plugCount: 2 } };
    expect(countAssemblyTotalPlugsCheap(parts, catalog, ZoneType.ACTIVE_ARENA)).toBe(2);
  });

  it('case 15: 多 part 求和', () => {
    const parts = {
      p1: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA },   // 2 plug
      p2: { ldrawId: '2780.dat', zone: ZoneType.ACTIVE_ARENA },  // 2 plug
      p3: { ldrawId: '40490.dat', zone: ZoneType.ACTIVE_ARENA }, // 1 plug
    };
    const catalog = {
      '170.dat': { plugCount: 2 },
      '2780.dat': { plugCount: 2 },
      '40490.dat': { plugCount: 1 },
    };
    expect(countAssemblyTotalPlugsCheap(parts, catalog, ZoneType.ACTIVE_ARENA)).toBe(5);
  });

  it('case 16: 非 ACTIVE_ARENA 零件不计入', () => {
    const parts = {
      p1: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA },
      p2: { ldrawId: '170.dat', zone: ZoneType.STAGED },
    };
    const catalog = { '170.dat': { plugCount: 2 } };
    expect(countAssemblyTotalPlugsCheap(parts, catalog, ZoneType.ACTIVE_ARENA)).toBe(2);
  });

  it('case 17: 装饰类零件 plugCount=0 → 不计数', () => {
    const parts = {
      decor: { ldrawId: 'sticker.dat', zone: ZoneType.ACTIVE_ARENA },
    };
    const catalog = { 'sticker.dat': { plugCount: 0 } };
    expect(countAssemblyTotalPlugsCheap(parts, catalog, ZoneType.ACTIVE_ARENA)).toBe(0);
  });

  it('case 18: 老数据 plugCount 缺失 → 跳过该 part', () => {
    const parts = {
      p1: { ldrawId: 'NEW.dat', zone: ZoneType.ACTIVE_ARENA },
      p2: { ldrawId: 'OLD.dat', zone: ZoneType.ACTIVE_ARENA },
    };
    const catalog = {
      'NEW.dat': { plugCount: 3 },
      'OLD.dat': {},  // plugCount undefined
    };
    expect(countAssemblyTotalPlugsCheap(parts, catalog, ZoneType.ACTIVE_ARENA)).toBe(3);
  });
});

describe('countAssemblyFreePlugsCheap', () => {
  it('case 19: 空装配 → 0', () => {
    expect(countAssemblyFreePlugsCheap({}, {}, {}, ZoneType.ACTIVE_ARENA)).toBe(0);
  });

  it('case 20: 全无 occupied → plugCount 全可用', () => {
    const parts = { p1: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA } };
    const catalog = { '170.dat': { portCount: 8, plugCount: 2 } };
    expect(countAssemblyFreePlugsCheap(parts, catalog, {}, ZoneType.ACTIVE_ARENA)).toBe(2);
  });

  it('case 21: 部分 occupied → 下界 = plugCount - floor(occ × plugCount / portCount)', () => {
    // 2x4 plate: 8 port, 2 plug, avg=4
    const parts = { p1: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA } };
    const catalog = { '170.dat': { portCount: 8, plugCount: 2 } };
    // 2 occupied → 2 - floor(2*2/8) = 2 - 0 = 2
    expect(
      countAssemblyFreePlugsCheap(
        parts, catalog, { p1: { 'k1': 'a', 'k2': 'b' } }, ZoneType.ACTIVE_ARENA,
      ),
    ).toBe(2);
    // 4 occupied → 2 - floor(4*2/8) = 2 - 1 = 1（下界）
    expect(
      countAssemblyFreePlugsCheap(
        parts, catalog, { p1: { 'k1': 'a', 'k2': 'b', 'k3': 'c', 'k4': 'd' } },
        ZoneType.ACTIVE_ARENA,
      ),
    ).toBe(1);
  });

  it('case 22: 全占 → 0', () => {
    const parts = { p1: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA } };
    const catalog = { '170.dat': { portCount: 8, plugCount: 2 } };
    const allOccupied: Record<string, string> = {};
    for (let i = 0; i < 8; i++) allOccupied[`k${i}`] = 'peer';
    expect(
      countAssemblyFreePlugsCheap(parts, catalog, { p1: allOccupied }, ZoneType.ACTIVE_ARENA),
    ).toBe(0);
  });

  it('case 23: 占用数超 portCount（数据不一致）→ clamp 到 0', () => {
    const parts = { p1: { ldrawId: 'X.dat', zone: ZoneType.ACTIVE_ARENA } };
    const catalog = { 'X.dat': { portCount: 4, plugCount: 1 } };
    // occupied=10 → 1 - floor(10/4) = 1 - 2 = -1 → clamp 0
    const occ: Record<string, string> = {};
    for (let i = 0; i < 10; i++) occ[`k${i}`] = 'peer';
    expect(
      countAssemblyFreePlugsCheap(parts, catalog, { p1: occ }, ZoneType.ACTIVE_ARENA),
    ).toBe(0);
  });

  it('case 24: portCount / plugCount 缺失 → 跳过', () => {
    const parts = {
      p1: { ldrawId: 'GOOD.dat', zone: ZoneType.ACTIVE_ARENA },
      p2: { ldrawId: 'NO_PORT.dat', zone: ZoneType.ACTIVE_ARENA },
      p3: { ldrawId: 'NO_PLUG.dat', zone: ZoneType.ACTIVE_ARENA },
    };
    const catalog = {
      'GOOD.dat': { portCount: 2, plugCount: 1 },
      'NO_PORT.dat': { plugCount: 1 },          // portCount 缺
      'NO_PLUG.dat': { portCount: 4 },          // plugCount 缺
    };
    expect(
      countAssemblyFreePlugsCheap(parts, catalog, {}, ZoneType.ACTIVE_ARENA),
    ).toBe(1);  // 只 GOOD.dat 计入
  });

  it('case 25: 多 part 聚合（2 plate + 1 销）', () => {
    const parts = {
      a: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA },   // 8p / 2plug
      b: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA },
      c: { ldrawId: '2780.dat', zone: ZoneType.ACTIVE_ARENA },  // 2p / 2plug
    };
    const catalog = {
      '170.dat': { portCount: 8, plugCount: 2 },
      '2780.dat': { portCount: 2, plugCount: 2 },
    };
    // a 1 占 → 2-floor(1*2/8)=2; b 全 free → 2; c 1 占 → 2-floor(1*2/2)=1
    const occupied = {
      a: { 'ka': 'peer' },
      c: { 'kc': 'peer' },
    };
    expect(
      countAssemblyFreePlugsCheap(parts, catalog, occupied, ZoneType.ACTIVE_ARENA),
    ).toBe(5);
  });

  it('case 26: 非 ACTIVE_ARENA 零件被排除 (STAGED 不计入)', () => {
    const parts = {
      a: { ldrawId: '170.dat', zone: ZoneType.ACTIVE_ARENA },
      b: { ldrawId: '170.dat', zone: ZoneType.STAGED },
    };
    const catalog = { '170.dat': { portCount: 8, plugCount: 2 } };
    expect(
      countAssemblyFreePlugsCheap(parts, catalog, {}, ZoneType.ACTIVE_ARENA),
    ).toBe(2);
  });
});

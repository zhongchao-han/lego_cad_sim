/**
 * freePlugs.test.ts
 * =================
 * computeFreePlugs / computeAssemblyFreePlugs 派生视图单测。
 *
 * 走法 A 期 A2 — 测纯函数，无 React render。
 * 关键契约：plug 不锁 atomicity，partial 占用合法 → status 三态。
 */

import { describe, it, expect } from 'vitest';
import { computeFreePlugs, computeAssemblyFreePlugs } from '../utils/freePlugs';
import type { LDrawSite, LDrawPort, LDrawPlug } from '../useLDrawPart';
import { portKey } from '../store';
import type { Mat3 } from '../types';

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

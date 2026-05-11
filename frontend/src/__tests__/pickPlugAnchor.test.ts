/**
 * pickPlugAnchor.test.ts
 * ======================
 * B.2 — plug anchor 启发式（同方向过滤 + 重心最近）单测。
 *
 * 覆盖：
 *   - 单 port plug → 自身就是 anchor
 *   - 2x4 plate 8 stud（同方向）→ 中央 stud
 *   - 9-hole 贯通孔（顶 9 + 底 9 反向法线）→ 仅在 clicked 同方向那一面里选中央
 *   - clickedPort 无 plug_id / 装饰类 → 静默返 clicked
 *   - plug.members 全部查不到 sites → 静默返 clicked
 *   - anchor 等于 clicked → 复用 clicked 对象引用（不构造新对象）
 *   - globalPos 按 part 局部位移平移
 */

import { describe, it, expect } from 'vitest';
import { findAnchorMember, pickPlugAnchorPort } from '../utils/pickPlugAnchor';
import type { LDrawSite, LDrawPort, LDrawPlug } from '../useLDrawPart';
import type { SelectedPortInfo } from '../types';

const ROT_Y_UP: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const ROT_Y_DOWN: number[][] = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];

function port(name: string, position: [number, number, number], rotation = ROT_Y_UP): LDrawPort {
  return { name, type: 'stud.dat', position, rotation };
}

function site(id: string, position: [number, number, number], ports: LDrawPort[]): LDrawSite {
  return { id, position, occupied_by: null, ports };
}

function plug(plug_id: string, members: Array<[string, number]>): LDrawPlug {
  return {
    plug_id,
    label: 'mock',
    gender: 'MALE',
    profile: 'STUD',
    direction: [0, 1, 0],
    members,
    port_count: members.length,
    site_ids: [...new Set(members.map(([s]) => s))].sort(),
  };
}

function clicked(
  pos: [number, number, number],
  plug_id?: string,
  rotation = ROT_Y_UP,
): SelectedPortInfo {
  return {
    partId: 'partA',
    ldrawId: '170.dat',
    portType: 'stud',
    position: pos,
    rotation,
    globalPos: [pos[0] + 1, pos[1] + 2, pos[2] + 3],  // 模拟 part-world offset (1, 2, 3)
    globalQuat: [0, 0, 0, 1],
    plug_id,
  };
}

describe('findAnchorMember', () => {
  it('case 1: 单 port plug → 自身就是 anchor', () => {
    const p = port('p0', [0, 0.004, 0]);
    const sites = [site('s0', [0, 0, 0], [p])];
    const pl = plug('plug_single', [['s0', 0]]);
    const anchor = findAnchorMember(pl, sites, ROT_Y_UP);
    expect(anchor).toBe(p);
  });

  it('case 2: 2x4 plate 8 stud（同方向）→ 中央 stud', () => {
    // 2x4 = 2 行 4 列。x in {0, 0.008}, z in {0, 0.008, 0.016, 0.024}。y 全 0.004。
    const ports: LDrawPort[] = [];
    for (let x = 0; x < 2; x++) {
      for (let z = 0; z < 4; z++) {
        ports.push(port(`p${x}_${z}`, [x * 0.008, 0.004, z * 0.008]));
      }
    }
    const sites = [site('s_top', [0, 0, 0], ports)];
    const pl = plug('plug_top', ports.map((_, idx) => ['s_top', idx] as [string, number]));
    const anchor = findAnchorMember(pl, sites, ROT_Y_UP);
    expect(anchor).not.toBeNull();
    // 重心 ≈ (0.004, 0.004, 0.012)。最近的 stud：x∈{0,0.008}, z∈{0.008,0.016}（4 颗等距）
    // → 由实现的 stable iteration order 决定第一个命中。允许这 4 之一：
    const candidates = [
      [0, 0.004, 0.008], [0, 0.004, 0.016],
      [0.008, 0.004, 0.008], [0.008, 0.004, 0.016],
    ];
    const matched = candidates.some(c =>
      Math.abs(anchor!.position[0] - c[0]) < 1e-4
      && Math.abs(anchor!.position[1] - c[1]) < 1e-4
      && Math.abs(anchor!.position[2] - c[2]) < 1e-4,
    );
    expect(matched).toBe(true);
  });

  it('case 3: 9-hole 贯通孔（顶 9 + 底 9 反向法线）→ 同方向过滤后仅在顶面取重心', () => {
    // 顶面 9 孔: y=+0.004, x in {0..0.064:0.008}
    const topPorts: LDrawPort[] = [];
    for (let i = 0; i < 9; i++) {
      topPorts.push(port(`t${i}`, [i * 0.008, 0.004, 0], ROT_Y_UP));
    }
    // 底面 9 孔: y=-0.004, 反向法线
    const botPorts: LDrawPort[] = [];
    for (let i = 0; i < 9; i++) {
      botPorts.push(port(`b${i}`, [i * 0.008, -0.004, 0], ROT_Y_DOWN));
    }
    const sites = [
      site('s_top', [0.032, 0.004, 0], topPorts),
      site('s_bot', [0.032, -0.004, 0], botPorts),
    ];
    const members: Array<[string, number]> = [];
    for (let i = 0; i < 9; i++) members.push(['s_top', i]);
    for (let i = 0; i < 9; i++) members.push(['s_bot', i]);
    const pl = plug('plug_through', members);

    // clicked rotation = 顶面 → 过滤掉底面 9 → 在顶 9 取重心 (0.032, 0.004, 0)
    // → 中间那颗（t4，x=0.032）
    const anchor = findAnchorMember(pl, sites, ROT_Y_UP);
    expect(anchor?.name).toBe('t4');
    expect(anchor?.position[1]).toBe(0.004);
  });

  it('case 4: 9-hole 反向 click → 在底面 9 取中间', () => {
    const topPorts: LDrawPort[] = [];
    for (let i = 0; i < 9; i++) topPorts.push(port(`t${i}`, [i * 0.008, 0.004, 0], ROT_Y_UP));
    const botPorts: LDrawPort[] = [];
    for (let i = 0; i < 9; i++) botPorts.push(port(`b${i}`, [i * 0.008, -0.004, 0], ROT_Y_DOWN));
    const sites = [
      site('s_top', [0.032, 0.004, 0], topPorts),
      site('s_bot', [0.032, -0.004, 0], botPorts),
    ];
    const members: Array<[string, number]> = [];
    for (let i = 0; i < 9; i++) members.push(['s_top', i]);
    for (let i = 0; i < 9; i++) members.push(['s_bot', i]);
    const pl = plug('plug_through', members);

    const anchor = findAnchorMember(pl, sites, ROT_Y_DOWN);
    expect(anchor?.name).toBe('b4');
  });

  it('case 5: plug.members 空 → null', () => {
    const sites = [site('s0', [0, 0, 0], [port('p0', [0, 0, 0])])];
    const pl = plug('plug_empty', []);
    expect(findAnchorMember(pl, sites, ROT_Y_UP)).toBeNull();
  });

  it('case 6: plug.members 全部查不到 sites（数据失同步）→ null', () => {
    const sites = [site('s0', [0, 0, 0], [port('p0', [0, 0, 0])])];
    const pl = plug('plug_ghost', [['s_nonexistent', 0]]);
    expect(findAnchorMember(pl, sites, ROT_Y_UP)).toBeNull();
  });
});

describe('pickPlugAnchorPort', () => {
  it('case 7: clickedPort 无 plug_id → 静默返 clicked', () => {
    const sites = [site('s0', [0, 0, 0], [port('p0', [0, 0, 0])])];
    const c = clicked([0, 0, 0]);  // 无 plug_id
    expect(pickPlugAnchorPort(c, [], sites)).toBe(c);
  });

  it('case 8: plugs[] 找不到 clickedPort.plug_id → 静默返 clicked', () => {
    const sites = [site('s0', [0, 0, 0], [port('p0', [0, 0, 0])])];
    const c = clicked([0, 0, 0], 'plug_missing');
    expect(pickPlugAnchorPort(c, [], sites)).toBe(c);
  });

  it('case 9: anchor 等于 clicked → 返 clicked（不构造新对象，引用稳定）', () => {
    const p = port('p0', [0, 0.004, 0]);
    const sites = [site('s0', [0, 0, 0], [p])];
    const pl = plug('plug_single', [['s0', 0]]);
    const c = clicked([0, 0.004, 0], 'plug_single');
    const r = pickPlugAnchorPort(c, [pl], sites);
    expect(r).toBe(c);
  });

  it('case 10: anchor 跟 clicked 不同 → globalPos 按局部位移平移', () => {
    // plug 含 2 个 stud：p0=(0,0.004,0) p1=(0.01,0.004,0)。centroid=(0.005,...)
    // 离 centroid 最近的是 p0 或 p1（距 0.005，对称）；返第一个 = p0
    const p0 = port('p0', [0, 0.004, 0]);
    const p1 = port('p1', [0.01, 0.004, 0]);
    const sites = [site('s0', [0, 0, 0], [p0, p1])];
    const pl = plug('plug_dual', [['s0', 0], ['s0', 1]]);
    // 用户点 p1（远离 anchor），world offset (1,2,3) → p1.globalPos=(1.01,2.004,3)
    const c = clicked([0.01, 0.004, 0], 'plug_dual');
    const r = pickPlugAnchorPort(c, [pl], sites);
    // anchor = p0，position=(0,0.004,0)
    expect(r.position).toEqual([0, 0.004, 0]);
    // dx=-0.01, dy=0, dz=0 → globalPos = clicked.globalPos + (-0.01,0,0)
    expect(r.globalPos[0]).toBeCloseTo(1.01 - 0.01, 6);
    expect(r.globalPos[1]).toBeCloseTo(2.004, 6);
    expect(r.globalPos[2]).toBeCloseTo(3, 6);
    // plug_id 透传
    expect(r.plug_id).toBe('plug_dual');
    // partId / ldrawId / globalQuat 不变
    expect(r.partId).toBe('partA');
    expect(r.ldrawId).toBe('170.dat');
    expect(r.globalQuat).toEqual([0, 0, 0, 1]);
  });

  it('case 11: 装饰类零件 click（无 plug_id）→ pickPlugAnchorPort 跟 SiteGizmo 上游约束一起兜底', () => {
    // 模拟上游已经判过 info.plug_id 不空才走 plug 路径；这里直接调 pickPlugAnchorPort
    // 也要 graceful — 不动 clicked。
    const c = clicked([0, 0, 0]);  // 无 plug_id
    const r = pickPlugAnchorPort(c, [], []);
    expect(r).toBe(c);
  });
});

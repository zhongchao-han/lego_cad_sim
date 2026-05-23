/**
 * plugOutline.test.ts
 * ====================
 * 走法 A 期 B.1（v2，UX 反馈迭代）— plug hover 整组线框轮廓的几何纯函数单测。
 *
 * 替代旧 siteGizmo_plug_halo.test.ts（per-port 黄球方案已移除，因密集孔梁糊成
 * 一坨）。覆盖 SiteGizmo.computePlugOutlineBox：
 *   - 退化路径（null / 无 plug_id / 跨 part / plug 找不到 / 单 member）→ null
 *   - 9-hole beam（沿 Z 线性）→ 盒沿 Z 张开 + margin，X/Y 取 minThickness
 *   - 贯通孔（顶 y=+0.004 + 底 y=-0.004）→ 盒 Y 跨两面
 *   - center 落在 member AABB 中心
 */

import { describe, it, expect } from 'vitest';
import { computePlugOutlineBox, portDotVisuals } from '../components/SiteGizmo';
import type { LDrawSite, LDrawPort, LDrawPlug } from '../useLDrawPart';
import type { SelectedPortInfo } from '../types';

const LDU = 0.0004;
const ROT_UP = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const ROT_DOWN = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];

function port(name: string, position: [number, number, number], rotation = ROT_UP): LDrawPort {
  return { name, type: 'beamhole.dat', position, rotation };
}

function site(id: string, ports: LDrawPort[]): LDrawSite {
  return { id, position: ports[0]?.position ?? [0, 0, 0], occupied_by: null, ports };
}

function plug(plug_id: string, members: Array<[string, number]>): LDrawPlug {
  return {
    plug_id, label: 'mock', gender: 'FEMALE', profile: 'CYL',
    direction: [0, 1, 0], members,
    port_count: members.length,
    site_ids: [...new Set(members.map(([s]) => s))].sort(),
  };
}

function hovered(overrides: Partial<SelectedPortInfo> = {}): SelectedPortInfo {
  return {
    partId: 'partA', ldrawId: '40490.dat', portType: 'beamhole.dat',
    position: [0, 0.004, 0], rotation: ROT_UP,
    globalPos: [0, 0, 0], globalQuat: [0, 0, 0, 1],
    plug_id: 'plug_0',
    ...overrides,
  };
}

/** 9 个顶面孔沿 Z：z ∈ {0..0.064:0.008}, x=0, y=+0.004。 */
function beam9Sites(): LDrawSite[] {
  const sites: LDrawSite[] = [];
  for (let i = 0; i < 9; i++) {
    sites.push(site(`s${i}`, [port(`t${i}`, [0, 0.004, i * 0.008])]));
  }
  return sites;
}
function beam9Plug(): LDrawPlug {
  return plug('plug_0', Array.from({ length: 9 }, (_, i) => [`s${i}`, 0] as [string, number]));
}

describe('computePlugOutlineBox — 退化路径返 null', () => {
  const sites = beam9Sites();
  const plugs = [beam9Plug()];

  it('hoveredPort 为 null → null', () => {
    expect(computePlugOutlineBox({ hoveredPort: null, partId: 'partA', plugs, sites })).toBeNull();
  });

  it('hoveredPort 无 plug_id → null', () => {
    expect(computePlugOutlineBox({
      hoveredPort: hovered({ plug_id: undefined }), partId: 'partA', plugs, sites,
    })).toBeNull();
  });

  it('跨 part（partId 不匹配）→ null', () => {
    expect(computePlugOutlineBox({
      hoveredPort: hovered({ partId: 'partA' }), partId: 'partB', plugs, sites,
    })).toBeNull();
  });

  it('plug_id 在 plugs 里找不到 → null', () => {
    expect(computePlugOutlineBox({
      hoveredPort: hovered({ plug_id: 'plug_ghost' }), partId: 'partA', plugs, sites,
    })).toBeNull();
  });

  it('单 member plug → null（一个孔画框没意义）', () => {
    const single = [plug('plug_single', [['s0', 0]])];
    expect(computePlugOutlineBox({
      hoveredPort: hovered({ plug_id: 'plug_single' }), partId: 'partA', plugs: single, sites,
    })).toBeNull();
  });

  it('member 全部查不到对应 site/port（数据失同步）→ null', () => {
    const ghost = [plug('plug_g', [['nope0', 0], ['nope1', 0]])];
    expect(computePlugOutlineBox({
      hoveredPort: hovered({ plug_id: 'plug_g' }), partId: 'partA', plugs: ghost, sites,
    })).toBeNull();
  });
});

describe('computePlugOutlineBox — 9-hole beam 几何', () => {
  it('盒沿 Z 张开（含 margin），X/Y 退化到 minThickness，center 居中', () => {
    const box = computePlugOutlineBox({
      hoveredPort: hovered(), partId: 'partA', plugs: [beam9Plug()], sites: beam9Sites(),
    });
    expect(box).not.toBeNull();
    const margin = 9 * LDU, minT = 6 * LDU;
    // z: 0..0.064 → 0.064 + 2*margin
    expect(box!.size[2]).toBeCloseTo(0.064 + 2 * margin, 6);
    // x: 全 0 → 2*margin = 0.0072 > minT 0.0024 → 0.0072
    expect(box!.size[0]).toBeCloseTo(2 * margin, 6);
    // y: 全 0.004 → 同 x
    expect(box!.size[1]).toBeCloseTo(2 * margin, 6);
    expect(box!.size[1]).toBeGreaterThanOrEqual(minT);
    // center: x=0, y=0.004, z=0.032
    expect(box!.center[0]).toBeCloseTo(0, 6);
    expect(box!.center[1]).toBeCloseTo(0.004, 6);
    expect(box!.center[2]).toBeCloseTo(0.032, 6);
  });
});

describe('computePlugOutlineBox — 贯通孔双面', () => {
  it('顶 y=+0.004 + 底 y=-0.004 → 盒 Y 跨两面，center y=0', () => {
    // 顶 3 + 底 3，同 z 列
    const sites: LDrawSite[] = [];
    for (let i = 0; i < 3; i++) {
      sites.push(site(`top${i}`, [port(`t${i}`, [0, 0.004, i * 0.008], ROT_UP)]));
      sites.push(site(`bot${i}`, [port(`b${i}`, [0, -0.004, i * 0.008], ROT_DOWN)]));
    }
    const members: Array<[string, number]> = [];
    for (let i = 0; i < 3; i++) { members.push([`top${i}`, 0]); members.push([`bot${i}`, 0]); }
    const through = plug('plug_through', members);

    const box = computePlugOutlineBox({
      hoveredPort: hovered({ plug_id: 'plug_through' }), partId: 'partA',
      plugs: [through], sites,
    });
    expect(box).not.toBeNull();
    const margin = 9 * LDU;
    // y 跨 -0.004..0.004 = 0.008 + 2*margin
    expect(box!.size[1]).toBeCloseTo(0.008 + 2 * margin, 6);
    expect(box!.center[1]).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// portDotVisuals: 端口指示球可见性分档（含密集件抑制）
// ---------------------------------------------------------------------------
describe('portDotVisuals: 可见性分档', () => {
  const BASE = 0.9;

  it('未展开（showVisuals=false）→ 全透明，仅 hit-zone', () => {
    const v = portDotVisuals({ shouldShowVisuals: false, prominent: false, isDensePart: false, baseOpacity: BASE });
    expect(v).toEqual({ sphereOpacity: 0, colorWrite: false, showArrow: false });
  });

  it('prominent（直接 hover/选中）→ 全亮 baseOpacity + 画箭头（不论密集与否）', () => {
    const sparse = portDotVisuals({ shouldShowVisuals: true, prominent: true, isDensePart: false, baseOpacity: BASE });
    const dense = portDotVisuals({ shouldShowVisuals: true, prominent: true, isDensePart: true, baseOpacity: BASE });
    expect(sparse).toEqual({ sphereOpacity: BASE, colorWrite: true, showArrow: true });
    expect(dense).toEqual({ sphereOpacity: BASE, colorWrite: true, showArrow: true });
  });

  it('稀疏件 + 非 prominent → 淡化小点（0.2，不画箭头）', () => {
    const v = portDotVisuals({ shouldShowVisuals: true, prominent: false, isDensePart: false, baseOpacity: BASE });
    expect(v.sphereOpacity).toBeCloseTo(0.2, 6);
    expect(v.colorWrite).toBe(true);
    expect(v.showArrow).toBe(false);
  });

  it('密集件 + 非 prominent → 完全隐藏（opacity 0 + colorWrite false），只留 hit-zone', () => {
    const v = portDotVisuals({ shouldShowVisuals: true, prominent: false, isDensePart: true, baseOpacity: BASE });
    expect(v).toEqual({ sphereOpacity: 0, colorWrite: false, showArrow: false });
  });
});

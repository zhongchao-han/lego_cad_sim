/**
 * assemblyTree.test.ts
 * ====================
 * 树模型纯几何/图单测：地基根判定 + 动件子树切分。
 */

import { describe, it, expect } from 'vitest';
import { pickRootPart, computeMovingSubtree, computeMovingGroup, buildComponentGraph, pickGroundAnchors, type ConnGraph } from '../utils/assemblyTree';

/** 便捷构图：传若干无向边 [a,b]，建对称邻接。 */
function graph(edges: Array<[string, string]>): ConnGraph {
  const g: ConnGraph = {};
  for (const [a, b] of edges) {
    (g[a] ??= new Set()).add(b);
    (g[b] ??= new Set()).add(a);
  }
  return g;
}

describe('pickRootPart — 最靠地基（高度最小）者为根', () => {
  it('挑高度最小的件，跟大小无关', () => {
    const h: Record<string, number> = { base: 0, mid: 0.01, top: 0.02 };
    expect(pickRootPart(['top', 'mid', 'base'], id => h[id])).toBe('base');
  });
  it('高度相同 → 按 id 稳定取小者', () => {
    const h: Record<string, number> = { b: 0, a: 0 };
    expect(pickRootPart(['b', 'a'], id => h[id])).toBe('a');
  });
  it('空组 → null', () => {
    expect(pickRootPart([], () => 0)).toBeNull();
  });
});

describe('pickGroundAnchors — 没有更低邻居的构件才是地基锚点', () => {
  it('并排同高 L-R → 两个都是锚点（谁都不比谁低）', () => {
    const g = graph([['L', 'R']]);
    const h: Record<string, number> = { L: 0, R: 0 };
    expect(new Set(pickGroundAnchors(g, ['L', 'R'], id => h[id]))).toEqual(new Set(['L', 'R']));
  });

  it('底板上叠平板：平板邻居(底板)更低 → 平板不是锚点，只有底板是', () => {
    const g = graph([['base', 'plate']]);
    const h: Record<string, number> = { base: 0, plate: 0.0032 }; // 平板高 3.2mm
    expect(pickGroundAnchors(g, ['base', 'plate'], id => h[id])).toEqual(['base']);
  });

  it('竖塔 base-plate-brick → 只有最底的 base 是锚点', () => {
    const g = graph([['base', 'plate'], ['plate', 'brick']]);
    const h: Record<string, number> = { base: 0, plate: 0.0032, brick: 0.0096 };
    expect(pickGroundAnchors(g, ['base', 'plate', 'brick'], id => h[id])).toEqual(['base']);
  });

  it('拱形：两立柱(地面)+横梁(架在柱上) → 两根柱都是锚点，梁不是', () => {
    const g = graph([['p1', 'beam'], ['p2', 'beam']]);
    const h: Record<string, number> = { p1: 0, p2: 0, beam: 0.0096 };
    expect(new Set(pickGroundAnchors(g, ['p1', 'p2', 'beam'], id => h[id]))).toEqual(new Set(['p1', 'p2']));
  });
});

describe('buildComponentGraph — 胶水折叠成边', () => {
  it('A-pin-B（pin 是胶水）→ 构件图里 A、B 直接相邻', () => {
    const g = graph([['A', 'pin'], ['pin', 'B']]);
    const cg = buildComponentGraph(g, ['A', 'B', 'pin'], id => id === 'pin');
    expect(new Set(cg.A)).toEqual(new Set(['B']));
    expect(new Set(cg.B)).toEqual(new Set(['A']));
    expect(cg.pin).toBeUndefined();
  });
});

describe('computeMovingSubtree — 移除选中件后与根断开的件即动件', () => {
  // 竖直塔：base(地基) - plate - brick；root=base。
  const tower = graph([['base', 'plate'], ['plate', 'brick']]);
  const compTower = ['base', 'plate', 'brick'];

  it('挪中间层 plate → 动 plate + 其上游离根的 brick，base 不动', () => {
    const moving = computeMovingSubtree(tower, compTower, ['plate'], 'base');
    expect(new Set(moving)).toEqual(new Set(['plate', 'brick']));
  });

  it('挪顶层 brick → 只动 brick（叶子）', () => {
    const moving = computeMovingSubtree(tower, compTower, ['brick'], 'base');
    expect(moving).toEqual(['brick']);
  });

  it('挪地基 base（含根）→ 整组都动（搬整堆）', () => {
    const moving = computeMovingSubtree(tower, compTower, ['base'], 'base');
    expect(new Set(moving)).toEqual(new Set(compTower));
  });

  it('侧面叶子：base 上横插一个 pin → 挪 pin 只动 pin，板不动', () => {
    const g = graph([['base', 'pin']]);
    const moving = computeMovingSubtree(g, ['base', 'pin'], ['pin'], 'base');
    expect(moving).toEqual(['pin']);
  });

  it('环：base-a-d-c-base（d 经两条路连回根）→ 挪 a 时 d 不动', () => {
    // a、c 都连 base，d 同时连 a 和 c → 拿掉 a，d 仍经 c 连回 base。
    const g = graph([['base', 'a'], ['base', 'c'], ['a', 'd'], ['c', 'd']]);
    const comp = ['base', 'a', 'c', 'd'];
    const moving = computeMovingSubtree(g, comp, ['a'], 'base');
    expect(moving).toEqual(['a']);
  });

  it('root 为 null → 整组都动', () => {
    const moving = computeMovingSubtree(tower, compTower, ['plate'], null);
    expect(new Set(moving)).toEqual(new Set(compTower));
  });

  it('多选：同时选 plate + brick → 都进动件', () => {
    const moving = computeMovingSubtree(tower, compTower, ['plate', 'brick'], 'base');
    expect(new Set(moving)).toEqual(new Set(['plate', 'brick']));
  });

  it('多锚点（虚拟地基根）：并排两件 L-R 都是锚点，挪 L 只动 L，R 当参考不动', () => {
    const g = graph([['L', 'R']]);
    const moving = computeMovingSubtree(g, ['L', 'R'], ['L'], ['L', 'R']);
    expect(moving).toEqual(['L']);
  });

  it('多锚点：三件一排 L-M-R 都是锚点，挪中间 M → 只动 M（L、R 各自连回虚拟根）', () => {
    // 旧的「单根」模型挪中间会把一侧也带走；多锚点下 L、R 都直连虚拟根 → 都不动。
    const g = graph([['L', 'M'], ['M', 'R']]);
    const moving = computeMovingSubtree(g, ['L', 'M', 'R'], ['M'], ['L', 'M', 'R']);
    expect(moving).toEqual(['M']);
  });

  it('多锚点：锚点全被选中 → 无可用源 → 整组都动', () => {
    const g = graph([['L', 'R']]);
    const moving = computeMovingSubtree(g, ['L', 'R'], ['L', 'R'], ['L', 'R']);
    expect(new Set(moving)).toEqual(new Set(['L', 'R']));
  });
});

describe('computeMovingGroup — 胶水模型（连接件随构件走）', () => {
  // 面板 panel 通过 4 颗销 pin1..4 粘在底板 base 上；销=胶水。
  // 关键：销同时连 panel 和 base（桥）。
  const isConn = (id: string) => id.startsWith('pin');
  const glued = graph([
    ['panel', 'pin1'], ['pin1', 'base'],
    ['panel', 'pin2'], ['pin2', 'base'],
    ['panel', 'pin3'], ['pin3', 'base'],
  ]);
  const compG = ['panel', 'base', 'pin1', 'pin2', 'pin3'];

  it('移动面板：4 颗桥接销当胶水跟面板走，底板不动', () => {
    const moving = computeMovingGroup(glued, compG, ['panel'], 'base', isConn);
    expect(new Set(moving)).toEqual(new Set(['panel', 'pin1', 'pin2', 'pin3']));
    expect(moving).not.toContain('base');
  });

  it('销桥到底板也不会被划到地基侧（根治"移动又掉"）：连续两次取分组结果一致', () => {
    const m1 = computeMovingGroup(glued, compG, ['panel'], 'base', isConn);
    // 即使销同时连着 base，第二次仍把它们算进 moving（胶水依附 panel）
    const m2 = computeMovingGroup(glued, compG, ['panel'], 'base', isConn);
    expect(new Set(m1)).toEqual(new Set(m2));
    expect(new Set(m1)).toEqual(new Set(['panel', 'pin1', 'pin2', 'pin3']));
  });

  it('移动底板(根)：整堆都动（胶水也跟着）', () => {
    const moving = computeMovingGroup(glued, compG, ['base'], 'base', isConn);
    expect(new Set(moving)).toEqual(new Set(compG));
  });

  it('两构件直接相连(无胶水)：挪上面的构件，下面的(根)不动', () => {
    const g = graph([['top', 'bottom']]);
    const moving = computeMovingGroup(g, ['top', 'bottom'], ['top'], 'bottom', () => false);
    expect(moving).toEqual(['top']);
  });

  it('只选了胶水(销)：只动这颗销', () => {
    const moving = computeMovingGroup(glued, compG, ['pin1'], 'base', isConn);
    expect(moving).toEqual(['pin1']);
  });
});

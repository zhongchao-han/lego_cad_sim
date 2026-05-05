/**
 * staticsMath.test.ts — L51 v1 + L51b PR-A 整体 COM + 凸包 + 稳定性
 * ===================================================================
 * v1 测试用 StabilityPart 但不传 comLocal / bbox*，行为与 v1 一致；
 * PR-A 新增测试覆盖 ⑤ part-local COM 修正 + ④ bbox footprint 升级。
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeStability,
  computeCenterOfMass,
  convexHull2D,
  partWorldCom,
  partWorldCorners,
  pointInConvexHull,
  type StabilityPart,
} from '../utils/staticsMath';
import type { Vec3 } from '../types';

const expectVec = (a: Vec3 | null, b: Vec3, eps = 1e-6) => {
  expect(a).not.toBeNull();
  if (!a) return;
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
  expect(Math.abs(a[2] - b[2])).toBeLessThan(eps);
};

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];

// ─── v1 等价测试（不传 comLocal / bbox） ───────────────────────────────────
describe('computeCenterOfMass — v1 path (不传 comLocal)', () => {
  it('empty input → null', () => {
    expect(computeCenterOfMass([])).toBeNull();
  });

  it('single point → COM at that point', () => {
    expectVec(computeCenterOfMass([{ position: [1, 2, 3], mass: 1.0 }]), [1, 2, 3]);
  });

  it('two equal-mass parts → midpoint', () => {
    expectVec(computeCenterOfMass([
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
    ]), [5, 0, 0]);
  });

  it('1:3 mass ratio → COM 偏向重的 1/4 距离处', () => {
    expectVec(computeCenterOfMass([
      { position: [0, 0, 0], mass: 1 },
      { position: [4, 0, 0], mass: 3 },
    ]), [3, 0, 0]);
  });

  it('mass=0 自动 fallback 到默认 0.001 kg', () => {
    expectVec(computeCenterOfMass([
      { position: [1, 2, 3], mass: 0 },
      { position: [4, 5, 6], mass: 0 },
    ]), [2.5, 3.5, 4.5], 1e-9);
  });
});

// ─── L51b ⑤ part-local COM 修正 ────────────────────────────────────────────
describe('partWorldCom — ⑤ part-local COM 修正', () => {
  it('comLocal null → 退化到 part.position（v1 行为）', () => {
    expectVec(partWorldCom({ position: [3, 7, 5], mass: 1, comLocal: null }), [3, 7, 5]);
  });

  it('comLocal=(0.1,0,0) + identity quat → 沿 X 偏 0.1', () => {
    expectVec(
      partWorldCom({ position: [3, 7, 5], mass: 1, comLocal: [0.1, 0, 0], quaternion: IDENTITY }),
      [3.1, 7, 5],
    );
  });

  it('comLocal=(0.1,0,0) + Ry(+90°) → 旋转后沿 -Z 偏 0.1（局部 +X 转到世界 -Z）', () => {
    // Ry(+π/2) 把局部 +X 转到世界 -Z；comLocal 也跟着转
    const q: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    expectVec(
      partWorldCom({ position: [0, 0, 0], mass: 1, comLocal: [0.1, 0, 0], quaternion: q }),
      [0, 0, -0.1],
      1e-6,
    );
  });
});

describe('computeCenterOfMass — ⑤ 综合 path', () => {
  it('两零件，各自 comLocal 偏心 → COM 反映 part-local 修正', () => {
    // part A 在 (0,0,0)，com_local (1,0,0) → world COM = (1,0,0)
    // part B 在 (10,0,0)，com_local (-1,0,0) → world COM = (9,0,0)
    // 整体（等质量）= (5,0,0)
    expectVec(computeCenterOfMass([
      { position: [0, 0, 0], mass: 1, comLocal: [1, 0, 0] },
      { position: [10, 0, 0], mass: 1, comLocal: [-1, 0, 0] },
    ]), [5, 0, 0]);
  });

  it('comLocal=null 与 comLocal=(0,0,0) 等效（都退化到 position）', () => {
    const a = computeCenterOfMass([{ position: [3, 7, 5], mass: 1 }]);
    const b = computeCenterOfMass([{ position: [3, 7, 5], mass: 1, comLocal: [0, 0, 0] }]);
    expectVec(a, b ?? [0, 0, 0]);
  });
});

// ─── L51b ④ bbox 8 corners ─────────────────────────────────────────────────
describe('partWorldCorners — ④ bbox 角点', () => {
  it('bboxSize null → 退化为单点 = part.position', () => {
    const corners = partWorldCorners({ position: [1, 2, 3], mass: 1 });
    expect(corners.length).toBe(1);
    expectVec(corners[0], [1, 2, 3]);
  });

  it('bboxSize=(2,2,2) center=(0,0,0) identity → 8 角点 = ±1', () => {
    const corners = partWorldCorners({
      position: [0, 0, 0], mass: 1,
      bboxSize: [2, 2, 2], bboxCenter: [0, 0, 0], quaternion: IDENTITY,
    });
    expect(corners.length).toBe(8);
    // 所有角点 |x|=|y|=|z|=1
    for (const c of corners) {
      expect(Math.abs(c[0])).toBeCloseTo(1);
      expect(Math.abs(c[1])).toBeCloseTo(1);
      expect(Math.abs(c[2])).toBeCloseTo(1);
    }
  });

  it('bbox 偏移 + 平移 → 角点跟着平移', () => {
    const corners = partWorldCorners({
      position: [10, 0, 0], mass: 1,
      bboxSize: [2, 2, 2], bboxCenter: [0, 0, 0], quaternion: IDENTITY,
    });
    // 所有 x ∈ {9, 11}
    for (const c of corners) {
      expect([9, 11]).toContain(c[0]);
    }
  });
});

// ─── 凸包 / 点判定（PR-A 行为不变，回归保护） ─────────────────────────────
describe('convexHull2D', () => {
  it('零点 / 单点 退化', () => {
    expect(convexHull2D([])).toEqual([]);
    expect(convexHull2D([[1, 1]])).toEqual([[1, 1]]);
  });

  it('正方形 4 顶点 + 1 内点 → 凸包 4 顶点', () => {
    const hull = convexHull2D([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
    expect(hull.length).toBe(4);
  });

  it('共线 3 点 → 退化为线段两端点', () => {
    expect(convexHull2D([[0, 0], [1, 0], [2, 0]]).length).toBe(2);
  });
});

describe('pointInConvexHull', () => {
  const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('内 / 外 / 边 / 顶点', () => {
    expect(pointInConvexHull([5, 5], square)).toBe(true);
    expect(pointInConvexHull([15, 5], square)).toBe(false);
    expect(pointInConvexHull([5, 0], square)).toBe(true);
    expect(pointInConvexHull([0, 0], square)).toBe(true);
  });

  it('退化 hull 单点 / 线段', () => {
    expect(pointInConvexHull([0, 0], [[0, 0]])).toBe(true);
    expect(pointInConvexHull([1, 0], [[0, 0]])).toBe(false);
    const seg: Array<[number, number]> = [[0, 0], [10, 0]];
    expect(pointInConvexHull([5, 0], seg)).toBe(true);
    expect(pointInConvexHull([5, 1], seg)).toBe(false);
  });

  it('空 hull → false', () => {
    expect(pointInConvexHull([0, 0], [])).toBe(false);
  });
});

// ─── analyzeStability v1 等价 + L51b 升级行为 ──────────────────────────────
describe('analyzeStability — v1 等价（不传 bbox / comLocal）', () => {
  it('4 part 矩形 → 稳定', () => {
    const r = analyzeStability([
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
      { position: [10, 0, 10], mass: 1 },
      { position: [0, 0, 10], mass: 1 },
    ]);
    expect(r.isStable).toBe(true);
  });

  it('4 part 矩形 + 重物悬空 → unstable', () => {
    const r = analyzeStability([
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
      { position: [10, 0, 10], mass: 1 },
      { position: [0, 0, 10], mass: 1 },
      { position: [50, 5, 5], mass: 100 },  // Y=5 悬空
    ]);
    expect(r.isStable).toBe(false);
  });

  it('单 part / 空 / 双 part 边界', () => {
    expect(analyzeStability([]).com).toBeNull();
    expect(analyzeStability([{ position: [3, 7, 5], mass: 1 }]).isStable).toBe(true);
  });
});

describe('analyzeStability — ④ bbox footprint 升级', () => {
  it('扁平大盘（10×10）单零件 + COM 落盘内 → 稳定', () => {
    // v1: footprint = part.position 单点 → COM 必在该点（凸包是单点+容差） → 稳定
    // PR-A: footprint = 8 corners 的 Y-min 集合 (4 corners on Y=-1) → 矩形
    //       COM = part.position = (0,0,0) → 落矩形内 → 稳定（与 v1 同结论但通过更强检验）
    const r = analyzeStability([{
      position: [0, 0, 0], mass: 1,
      bboxSize: [10, 2, 10], bboxCenter: [0, 0, 0], quaternion: IDENTITY,
    }]);
    expect(r.isStable).toBe(true);
    // footprint 应是 4 角矩形（Y=-1 的 corners）
    expect(r.footprint.length).toBe(4);
  });

  it('扁平大盘 + 偏心重物（无 bbox）落盘外 → unstable', () => {
    // 大盘提供 footprint 4 角矩形 ±5；重物在 (20, 5, 0) 拉 COM 出盘
    const r = analyzeStability([
      {
        position: [0, 0, 0], mass: 1,
        bboxSize: [10, 2, 10], bboxCenter: [0, 0, 0], quaternion: IDENTITY,
      },
      // 重物：无 bbox 退化为 position 单点；Y=5 高于 footprint，Y-min 检测剔除
      { position: [20, 5, 0], mass: 100 },
    ]);
    // 重物大幅拉 COM → COM_x 远 > 5 → 落盘 footprint (-5..5) 之外
    expect(r.isStable).toBe(false);
  });

  it('扁平盘 footprint 含 9 角包含小腿 contact → 与单纯 origin 不同', () => {
    // 一个零件位置 (0,0,0)，bbox (10,2,10) → footprint Y=-1 的 4 corners 涵盖 ±5 矩形
    // 跟 v1 仅 (0,0,0) 单点 footprint 形成对比 —— PR-A footprint 范围远大
    const partWithBbox = analyzeStability([{
      position: [0, 0, 0], mass: 1,
      bboxSize: [10, 2, 10], bboxCenter: [0, 0, 0], quaternion: IDENTITY,
    }]);
    const partV1Style = analyzeStability([{
      position: [0, 0, 0], mass: 1,
    }]);
    expect(partWithBbox.footprint.length).toBe(4);
    expect(partV1Style.footprint.length).toBe(1);
  });
});

describe('analyzeStability — ⑤ part-local COM 影响整体 COM', () => {
  it('双盘对称 + 各自 com_local 反向偏 → 整体 COM 仍居中', () => {
    const r = analyzeStability([
      { position: [0, 0, 0], mass: 1, comLocal: [1, 0, 0] },
      { position: [10, 0, 0], mass: 1, comLocal: [-1, 0, 0] },
    ]);
    expectVec(r.com, [5, 0, 0]);
  });
});

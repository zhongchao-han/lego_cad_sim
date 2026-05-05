/**
 * staticsMath.test.ts — L51 整体 COM + 凸包 + 稳定性
 * ===================================================
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeStability,
  computeCenterOfMass,
  convexHull2D,
  pointInConvexHull,
  type MassPoint,
} from '../utils/staticsMath';
import type { Vec3 } from '../types';

const expectVec = (a: Vec3 | null, b: Vec3, eps = 1e-6) => {
  expect(a).not.toBeNull();
  if (!a) return;
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
  expect(Math.abs(a[2] - b[2])).toBeLessThan(eps);
};

describe('computeCenterOfMass', () => {
  it('empty input → null', () => {
    expect(computeCenterOfMass([])).toBeNull();
  });

  it('single point → COM at that point', () => {
    expectVec(computeCenterOfMass([{ position: [1, 2, 3], mass: 1.0 }]), [1, 2, 3]);
  });

  it('two equal-mass parts → midpoint', () => {
    const pts: MassPoint[] = [
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
    ];
    expectVec(computeCenterOfMass(pts), [5, 0, 0]);
  });

  it('two parts with 1:3 mass ratio → COM 偏向重的 1/4 距离处', () => {
    const pts: MassPoint[] = [
      { position: [0, 0, 0], mass: 1 },
      { position: [4, 0, 0], mass: 3 },
    ];
    // mass-weighted: (1*0 + 3*4) / 4 = 3
    expectVec(computeCenterOfMass(pts), [3, 0, 0]);
  });

  it('mass=0 自动 fallback 到默认 0.001 kg，不让分母为 0', () => {
    const com = computeCenterOfMass([
      { position: [1, 2, 3], mass: 0 },
      { position: [4, 5, 6], mass: 0 },
    ]);
    // 都用默认 0.001：等质量，COM = midpoint
    expectVec(com, [2.5, 3.5, 4.5], 1e-9);
  });
});

describe('convexHull2D', () => {
  it('零点 / 单点 / 两点 退化', () => {
    expect(convexHull2D([])).toEqual([]);
    expect(convexHull2D([[1, 1]])).toEqual([[1, 1]]);
  });

  it('三角形 3 顶点', () => {
    const hull = convexHull2D([[0, 0], [4, 0], [2, 3]]);
    expect(hull.length).toBe(3);
  });

  it('正方形 4 顶点 + 1 内点 → 凸包应只含 4 顶点', () => {
    const pts: Array<[number, number]> = [
      [0, 0], [10, 0], [10, 10], [0, 10], [5, 5],
    ];
    const hull = convexHull2D(pts);
    expect(hull.length).toBe(4);
    // 内点 (5,5) 不应在 hull 中
    expect(hull.some(p => p[0] === 5 && p[1] === 5)).toBe(false);
  });

  it('共线 3 点 → 退化为线段两端点', () => {
    const hull = convexHull2D([[0, 0], [1, 0], [2, 0]]);
    expect(hull.length).toBe(2);
  });
});

describe('pointInConvexHull', () => {
  const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('点在内部 → true', () => {
    expect(pointInConvexHull([5, 5], square)).toBe(true);
  });

  it('点在外部 → false', () => {
    expect(pointInConvexHull([15, 5], square)).toBe(false);
    expect(pointInConvexHull([-1, 5], square)).toBe(false);
  });

  it('点在边上 → true（含边界）', () => {
    expect(pointInConvexHull([5, 0], square)).toBe(true);
    expect(pointInConvexHull([10, 5], square)).toBe(true);
  });

  it('点在顶点 → true', () => {
    expect(pointInConvexHull([0, 0], square)).toBe(true);
  });

  it('退化 hull：单点 vs 距离', () => {
    expect(pointInConvexHull([0, 0], [[0, 0]])).toBe(true);
    expect(pointInConvexHull([0.0001, 0], [[0, 0]])).toBe(true); // 1mm 容差内
    expect(pointInConvexHull([1, 0], [[0, 0]])).toBe(false);
  });

  it('退化 hull：两点（线段）', () => {
    const seg: Array<[number, number]> = [[0, 0], [10, 0]];
    expect(pointInConvexHull([5, 0], seg)).toBe(true);    // 中点
    expect(pointInConvexHull([0, 0], seg)).toBe(true);    // 端点
    expect(pointInConvexHull([5, 1], seg)).toBe(false);   // 偏离线段
    expect(pointInConvexHull([15, 0], seg)).toBe(false);  // 越过线段
  });

  it('空 hull → false', () => {
    expect(pointInConvexHull([0, 0], [])).toBe(false);
  });
});

describe('analyzeStability', () => {
  it('4 part 矩形 + COM 在中央 → 稳定', () => {
    const pts: MassPoint[] = [
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
      { position: [10, 0, 10], mass: 1 },
      { position: [0, 0, 10], mass: 1 },
    ];
    const r = analyzeStability(pts);
    expect(r.isStable).toBe(true);
    expectVec(r.com, [5, 0, 5]);
    expect(r.footprint.length).toBe(4);
  });

  it('4 part 矩形 + 重物在顶部偏外 → unstable', () => {
    const pts: MassPoint[] = [
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
      { position: [10, 0, 10], mass: 1 },
      { position: [0, 0, 10], mass: 1 },
      // 顶部偏 X 方向悬出去 100kg
      { position: [50, 5, 5], mass: 100 },
    ];
    const r = analyzeStability(pts);
    expect(r.isStable).toBe(false);
    // 重物拉的 COM 一定在矩形 footprint 之外
    if (r.com) expect(r.com[0]).toBeGreaterThan(15);
  });

  it('单 part → 稳定（footprint 退化为单点，COM 与之重合）', () => {
    const pts: MassPoint[] = [{ position: [3, 7, 5], mass: 1 }];
    const r = analyzeStability(pts);
    expect(r.isStable).toBe(true);
    expectVec(r.com, [3, 7, 5]);
  });

  it('两 part 等质量在线段上 → COM 在中点 → 稳定', () => {
    const pts: MassPoint[] = [
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
    ];
    const r = analyzeStability(pts);
    expect(r.isStable).toBe(true);
  });

  it('空集合 → COM null + unstable', () => {
    const r = analyzeStability([]);
    expect(r.com).toBeNull();
    expect(r.isStable).toBe(false);
  });
});

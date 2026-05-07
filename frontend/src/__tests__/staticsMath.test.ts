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

// ─── 审计 Round 2 补：CONTACT_Y_TOLERANCE 边界 / 退化 footprint / 倾斜旋转 ──
//
// 现有覆盖已经走完 v1/PR-A 主路径，这一组补：
//   - CONTACT_Y_TOLERANCE_M = 0.0004 (1 LDU) 边界两侧的悬空剔除
//   - 退化 footprint（1 点 / 2 点 line segment）下的 pointInConvexHull 走
//     特殊分支 (_pointOnSegment / hull[0] 半径 hit)
//   - 倾斜旋转后 bbox 投影 Y-min 集合改变 → footprint 缩小
//   - mass=0 走 DEFAULT_MASS_KG fallback 时仍参与 footprint 收集

describe('analyzeStability — 边界 + 退化 footprint', () => {
  it('CONTACT_Y_TOLERANCE 边界内：Y 比 yMin 高 0.5 LDU (0.0002m) 仍算接触', () => {
    // 两个零件都贴地，但其中一个 Y 高 0.0002 m（半 LDU，<= TOL=0.0004）
    // → 都进 contact 集合 → footprint 含两个 corner
    const r = analyzeStability([
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0.0002, 0], mass: 1 },
    ]);
    // v1 路径，每零件 1 单点 corner → contact 2 点 → 凸包退化为线段（2 顶点）
    expect(r.footprint.length).toBe(2);
  });

  it('CONTACT_Y_TOLERANCE 边界外：Y 比 yMin 高 1.5 LDU (0.0006m) 被剔除', () => {
    // 第二零件高 0.0006 m > TOL 0.0004 → 不算接触 → footprint 仅含第一个
    const r = analyzeStability([
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0.0006, 0], mass: 1 },
    ]);
    expect(r.footprint.length).toBe(1);
  });

  it('退化单点 footprint：COM 落在 1mm 容差内 → stable', () => {
    // 单零件，无 bbox → footprint 单点 (0,0) in XZ
    // COM 也是 (0,0) → 落在容差内
    const r = analyzeStability([{ position: [0, 5, 0], mass: 1 }]);
    expect(r.footprint).toEqual([[0, 0]]);
    expect(r.isStable).toBe(true);
  });

  it('退化单点 footprint：COM 偏离 > HULL_EPS_M (1mm) → unstable', () => {
    // 单零件 footprint=(0,0)，com_local 偏 X+0.01m → COM (0.01,*,0)
    // 1cm > 1mm 容差 → 落 footprint 外
    const r = analyzeStability([
      { position: [0, 5, 0], mass: 1, comLocal: [0.01, 0, 0] },
    ]);
    expect(r.footprint.length).toBe(1);
    expect(r.isStable).toBe(false);
  });

  it('退化线段 footprint：COM 在线段中点 → stable（_pointOnSegment 命中）', () => {
    const r = analyzeStability([
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
    ]);
    expect(r.footprint.length).toBe(2);
    // COM 是 (5, 0, 0)，线段 (0,0)-(10,0) 中点 → stable
    expect(r.isStable).toBe(true);
  });

  it('退化线段 footprint：COM 偏离线段法向 > 1mm → unstable', () => {
    const r = analyzeStability([
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], mass: 1 },
      // 重物拉 COM 沿 Z 偏移；mass=10 让 COM_z 显著
      { position: [5, 5, 0.5], mass: 10 }, // Y=5 悬空，被 corner 剔除但参与 COM
    ]);
    expect(r.isStable).toBe(false);
  });

  it('倾斜旋转 → bbox Y-min 集合从 4 corners 退化为 1-2 corners (footprint 缩小)', () => {
    // 一个 (10,2,10) bbox，绕 Z 转 45° → bbox 不再水平，Y-min 不再是 4 个底面 corners
    // 而是少数几个被旋到最低位置的角点。具体几个不重要，关键是 < 4。
    const angle = Math.PI / 4;
    const cz = Math.cos(angle / 2);
    const sz = Math.sin(angle / 2);
    const quatZ45: [number, number, number, number] = [0, 0, sz, cz];
    const r = analyzeStability([{
      position: [0, 0, 0], mass: 1,
      bboxSize: [10, 2, 10], bboxCenter: [0, 0, 0], quaternion: quatZ45,
    }]);
    expect(r.footprint.length).toBeLessThan(4);
    expect(r.footprint.length).toBeGreaterThanOrEqual(1);
  });

  it('mass=0 零件走 DEFAULT_MASS_KG fallback，但 corner 仍参与 footprint 收集', () => {
    // mass=0 零件给 DEFAULT_MASS_KG 0.001 → 几乎不影响 COM
    // 但 partWorldCorners 不看 mass，corner 应进 footprint
    const r = analyzeStability([
      { position: [0, 0, 0], mass: 1, bboxSize: [2, 2, 2], bboxCenter: [0, 0, 0] },
      // mass=0 零件远离主体
      { position: [50, 0, 50], mass: 0, bboxSize: [2, 2, 2], bboxCenter: [0, 0, 0] },
    ]);
    // footprint 应至少 5 个 corner（包含远点的至少一个）
    // 但凸包 = 4 角矩形（远点拉高 footprint）
    expect(r.footprint.length).toBeGreaterThanOrEqual(3);
  });
});

describe('convexHull2D / pointInConvexHull — 边界扰动', () => {
  it('凸包顶点（角上）pointInConvexHull → true（cross == 0 命中容差）', () => {
    const hull = convexHull2D([[0, 0], [10, 0], [10, 10], [0, 10]]);
    // 顶点 (0,0)
    expect(pointInConvexHull([0, 0], hull)).toBe(true);
    // 边中点 (5, 0)
    expect(pointInConvexHull([5, 0], hull)).toBe(true);
    // 顶点外 1mm
    expect(pointInConvexHull([-0.0011, 0], hull)).toBe(false);
  });

  it('线段 hull：_pointOnSegment 容差 — cross 与 dot 双重判定 (HULL_EPS_M=1e-3)', () => {
    // ⚠ 已知 quirk：_pointOnSegment 的 cross 比较没归一化 segment length，
    //   长度 10m 的线段下，"法向距离 1mm" 实际产生 cross=0.01 > 1e-3 而被判外。
    //   等价于"法向距离 < 1e-3 / 10 = 0.1mm 才在线上"。这里 lock 当前行为。
    const hull: Array<[number, number]> = [[0, 0], [10, 0]];
    // 端点延长线方向：dot 检查 dot >= -HULL_EPS_M 即可。dot = (p-a)·(b-a) = (-0.0001)*10 = -0.001 == -HULL_EPS_M → true
    expect(pointInConvexHull([-0.0001, 0], hull)).toBe(true);
    // dot = -0.0002*10 = -0.002 < -1e-3 → 失败
    expect(pointInConvexHull([-0.0002, 0], hull)).toBe(false);
    // 法向偏 0.00005 m → cross=0.0005 < HULL_EPS_M → 在线上
    expect(pointInConvexHull([5, 0.00005], hull)).toBe(true);
    // 法向偏 0.0002 m → cross=0.002 > HULL_EPS_M → 外
    expect(pointInConvexHull([5, 0.0002], hull)).toBe(false);
  });
});

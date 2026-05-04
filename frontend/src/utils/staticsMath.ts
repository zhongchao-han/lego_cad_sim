/**
 * staticsMath.ts — L51 整体 COM 计算 + footprint 凸包 + 静态稳定性判定
 * ========================================================================
 * v1 简化（明确）：
 *   - 用 part.position 当每个零件的世界质心（忽略 part-local COM 偏移）
 *   - footprint = 所有 part.position 投到 XZ 平面的凸包（重力沿 -Y）
 *   - 稳定 = COM 投到地面后 (cx, cz) 落在 footprint 凸包内
 *
 * 反力求解 / vertex-based footprint / part-local COM 修正都在 L51b 范畴。
 */

import type { Vec3 } from '../types';

// 默认 fallback 质量：partCatalog 的 mass_kg 为 null 时（GLB 没烘 / 估算失败），
// 沿用旧 URDF exporter 的 0.001 kg 默认值，保持行为连续。
const DEFAULT_MASS_KG = 0.001;

export interface MassPoint {
  position: Vec3;     // 世界系位置（米）
  mass: number;       // kg
}

/**
 * 整体质心：mass-weighted average of positions。
 * 输入空 / 总质量为 0 → null。
 */
export function computeCenterOfMass(points: MassPoint[]): Vec3 | null {
  if (points.length === 0) return null;
  let sumM = 0;
  let sumX = 0, sumY = 0, sumZ = 0;
  for (const p of points) {
    const m = p.mass > 0 ? p.mass : DEFAULT_MASS_KG;
    sumM += m;
    sumX += m * p.position[0];
    sumY += m * p.position[1];
    sumZ += m * p.position[2];
  }
  if (sumM <= 0) return null;
  return [sumX / sumM, sumY / sumM, sumZ / sumM];
}

// ─── 2D 凸包（monotone chain）─────────────────────────────────────────────
/**
 * Andrew's monotone chain 算法：O(n log n)。
 * 输入点序列（未必排序），返回凸包顶点逆时针顺序（首尾不重复）。
 * 重复点 / 共线点会被去重。
 */
export function convexHull2D(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length <= 1) return [...pts];
  // 按 (x, y) 字典序排
  const sorted = [...pts].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  // 下半凸包
  const lower: Array<[number, number]> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  // 上半凸包
  const upper: Array<[number, number]> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  // 拼接，去末尾重复点
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ─── 点 ∈ 凸多边形检测 ────────────────────────────────────────────────────
/**
 * 判断点 p 是否在凸多边形 hull 内部或边界上（含边界）。
 * hull 顶点必须为逆时针有序（convexHull2D 输出已满足）。
 *
 * 退化处理：
 *   - hull 空 → 无支撑面 → 不稳定（false）
 *   - hull 1 点 → 仅当 p 与该点重合（含浮点容差）时稳定
 *   - hull 2 点（线段）→ 仅当 p 落在线段上（含端点）时稳定
 *
 * v1 容差：1mm = 1e-3 m（远大于浮点误差，给小型零件适当裕度）。
 */
const EPS_M = 1e-3;

export function pointInConvexHull(
  p: [number, number],
  hull: Array<[number, number]>,
): boolean {
  if (hull.length === 0) return false;
  if (hull.length === 1) {
    const dx = p[0] - hull[0][0];
    const dy = p[1] - hull[0][1];
    return Math.hypot(dx, dy) <= EPS_M;
  }
  if (hull.length === 2) {
    return _pointOnSegment(p, hull[0], hull[1]);
  }
  // 一般情况：检查 p 在所有边的同侧（凸多边形特性）
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (c < -EPS_M) return false; // p 在边右侧 → 凸包外
  }
  return true;
}

function _pointOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): boolean {
  // 共线检查（带容差）
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > EPS_M) return false;
  // 是否在 [a, b] 区间
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot >= -EPS_M && dot <= lenSq + EPS_M;
}

// ─── 静态稳定性判定 ────────────────────────────────────────────────────────
/**
 * Contact 容差：Y 坐标距全局最低点 < 此值的零件归为"接触地面"参与 footprint。
 * 1 LDU = 0.4mm；这里给 1 LDU 的容差吸收浮点误差与 LEGO 拼装的 micro-gap。
 */
const CONTACT_Y_TOLERANCE_M = 0.0004;

/**
 * 综合判定：给定一组 MassPoint，
 *   1. 算整体 COM（所有 part 参与质量加权）
 *   2. footprint = **Y 最低集合** 的 part position 在 XZ 平面投影的凸包
 *      —— 用 part.position 当 footprint 点是 v1 简化；要更准（取 part bbox
 *      最低 vertex / 实际接触点）需 part 几何，留 L51b
 *   3. COM 投到 Y=0 → (cx, cz)
 *   4. 稳定 ⇔ (cx, cz) ∈ footprint
 *
 * 关键设计点：footprint 不能包含全部 part position（否则 COM 作为凸组合
 * 永远落 hull 内，isStable 永远 true，判定失去意义）。区分"支撑点"vs"悬空点"
 * 是稳定性概念的核心。
 *
 * 返回 { com, isStable, footprint }；空集合返 isStable = false。
 */
export interface StabilityReport {
  com: Vec3 | null;
  isStable: boolean;
  /** Y 最低集合在 XZ 平面投影的 footprint 顶点（CCW）。 */
  footprint: Array<[number, number]>;
}

export function analyzeStability(points: MassPoint[]): StabilityReport {
  if (points.length === 0) {
    return { com: null, isStable: false, footprint: [] };
  }
  const com = computeCenterOfMass(points);

  // 找全局最低 Y
  let yMin = Infinity;
  for (const p of points) {
    if (p.position[1] < yMin) yMin = p.position[1];
  }
  // contact 集合：Y 距 yMin < tolerance 的零件（接触地面）
  const contactPts: Array<[number, number]> = [];
  for (const p of points) {
    if (p.position[1] - yMin <= CONTACT_Y_TOLERANCE_M) {
      contactPts.push([p.position[0], p.position[2]]);
    }
  }
  const footprint = convexHull2D(contactPts);

  if (com === null) return { com: null, isStable: false, footprint };
  const isStable = pointInConvexHull([com[0], com[2]], footprint);
  return { com, isStable, footprint };
}

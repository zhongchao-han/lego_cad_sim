/**
 * staticsMath.ts — L51 整体 COM + footprint 凸包 + 静态稳定性
 * ==============================================================
 *
 * L51 v1：用 part.position 当世界质心 + footprint 单点 → 倾向把所有
 *         配置判稳定（footprint 含全部 part position 时 COM 凸组合永在 hull 内）
 *         或低估 footprint（扁平大盘只用 origin 一点支撑）。
 *
 * L51b PR-A 升级：
 *   ⑤ part-local COM 修正 ——
 *     world_com_i = R_world(quaternion_i) · com_local_i + position_i
 *     之前用 position_i 直接代替，对偏心零件（电机壳 / 大齿轮）误差
 *     量级 = 零件半径 ~10-20%。
 *   ④ bbox 最低 vertex footprint ——
 *     每个 part 取 8 bbox 角点 → 转世界 → 取 Y-min 集合（contact tolerance
 *     1 LDU）→ XZ 凸包。比 v1 用 part origin 单点准确得多，扁平大盘的
 *     真实支撑面被还原。
 *
 * 反力求解 / 反力可视化 / 真应力留 PR-B 与 PR-C。
 */

import * as THREE from 'three';
import type { Vec3, Quat } from '../types';

// 默认 fallback 质量：partCatalog.massKg 为 null 时（GLB 没烘 / 估算失败），
// 沿用旧 URDF exporter 的 0.001 kg 默认值，保持行为连续。
const DEFAULT_MASS_KG = 0.001;

/** Contact 容差：Y 坐标距全局最低 < 此值的 corner 归为"接触地面"。
 *  1 LDU = 0.4mm，吸收浮点 + LEGO micro-gap。 */
const CONTACT_Y_TOLERANCE_M = 0.0004;

/** 凸包内点判定容差：1mm，给小型零件适当裕度。 */
const HULL_EPS_M = 1e-3;

// ─── L51b 富 part 描述符 ───────────────────────────────────────────────────
/**
 * staticsMath 输入：每个零件的世界位姿 + 估算质量 + 局部质心 + 局部 bbox。
 * comLocal / bboxSize / bboxCenter 任一为 null 时该路径退化到 v1 行为
 * （COM 用 part.position；footprint 用 part.position 单点）。
 */
export interface StabilityPart {
  position: Vec3;
  /** 默认 identity（不传也能跑，相当于无旋转）。 */
  quaternion?: Quat;
  /** 0 / undefined 走 DEFAULT_MASS_KG 让分母不为 0。 */
  mass: number;
  /** part-local 质心（米）；null → 用 position 当世界质心（v1 行为）。 */
  comLocal?: Vec3 | null;
  /** part-local axis-aligned bbox 尺寸（米）；null → footprint 用 position 单点。 */
  bboxSize?: Vec3 | null;
  /** bbox 中心相对 part origin 的偏移（part-local）；null → (0,0,0)。 */
  bboxCenter?: Vec3 | null;
}

// ─── 模块级 scratch：避免在 useMemo 重算时分配 GC（与 L54 / L44 同模式）───
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

function _rotateByQuat(out: Vec3, v: Vec3, q: Quat): Vec3 {
  _q.set(q[0], q[1], q[2], q[3]);
  _v.set(v[0], v[1], v[2]).applyQuaternion(_q);
  out[0] = _v.x; out[1] = _v.y; out[2] = _v.z;
  return out;
}

/**
 * 算单零件的世界质心：world_com = R_world · com_local + position。
 * comLocal 为 null 时退化到 part.position（v1 行为，向后兼容）。
 */
export function partWorldCom(part: StabilityPart): Vec3 {
  if (!part.comLocal) return [...part.position];
  const rot: Vec3 = [0, 0, 0];
  _rotateByQuat(rot, part.comLocal, part.quaternion ?? IDENTITY_QUAT);
  return [
    rot[0] + part.position[0],
    rot[1] + part.position[1],
    rot[2] + part.position[2],
  ];
}

/**
 * 算单零件的 8 个 bbox 角点（世界坐标）。bboxSize null 时返单点 = part.position。
 */
export function partWorldCorners(part: StabilityPart): Vec3[] {
  if (!part.bboxSize) return [[...part.position]];
  const size = part.bboxSize;
  const center = part.bboxCenter ?? [0, 0, 0];
  const half: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const q = part.quaternion ?? IDENTITY_QUAT;
  const corners: Vec3[] = [];
  const rotated: Vec3 = [0, 0, 0];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const localCorner: Vec3 = [
          center[0] + sx * half[0],
          center[1] + sy * half[1],
          center[2] + sz * half[2],
        ];
        _rotateByQuat(rotated, localCorner, q);
        corners.push([
          rotated[0] + part.position[0],
          rotated[1] + part.position[1],
          rotated[2] + part.position[2],
        ]);
      }
    }
  }
  return corners;
}

/**
 * 整体质心：mass-weighted average of partWorldCom。
 * 输入空 / 总质量为 0 → null。
 */
export function computeCenterOfMass(parts: StabilityPart[]): Vec3 | null {
  if (parts.length === 0) return null;
  let sumM = 0;
  let sumX = 0, sumY = 0, sumZ = 0;
  for (const p of parts) {
    const m = p.mass > 0 ? p.mass : DEFAULT_MASS_KG;
    const com = partWorldCom(p);
    sumM += m;
    sumX += m * com[0];
    sumY += m * com[1];
    sumZ += m * com[2];
  }
  if (sumM <= 0) return null;
  return [sumX / sumM, sumY / sumM, sumZ / sumM];
}

// ─── 2D 凸包（Andrew's monotone chain）────────────────────────────────────
/**
 * 输入点序列（未必排序），返回凸包顶点逆时针顺序（首尾不重复）。
 * O(n log n)。重复 / 共线点会被去除。
 */
export function convexHull2D(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length <= 1) return [...pts];
  const sorted = [...pts].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ─── 点 ∈ 凸多边形检测 ────────────────────────────────────────────────────
export function pointInConvexHull(
  p: [number, number],
  hull: Array<[number, number]>,
): boolean {
  if (hull.length === 0) return false;
  if (hull.length === 1) {
    const dx = p[0] - hull[0][0];
    const dy = p[1] - hull[0][1];
    return Math.hypot(dx, dy) <= HULL_EPS_M;
  }
  if (hull.length === 2) {
    return _pointOnSegment(p, hull[0], hull[1]);
  }
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (c < -HULL_EPS_M) return false;
  }
  return true;
}

function _pointOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > HULL_EPS_M) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot >= -HULL_EPS_M && dot <= lenSq + HULL_EPS_M;
}

// ─── 静态稳定性判定 ────────────────────────────────────────────────────────
/**
 * 综合判定：
 *   1. 整体 COM = mass-weighted average of partWorldCom（含 part-local COM 修正）
 *   2. 收集所有 part 的 bbox 8 角点（无 bbox 退化为 part.position 单点）
 *   3. footprint = 取 Y-min 容差集合的 corner 在 XZ 平面投影的凸包
 *   4. 稳定 ⇔ COM 投影 (cx, cz) ∈ footprint
 *
 * 关键：footprint **不能含全部 corner**（否则 COM 凸组合永在 hull 内）。
 * 区分接触地面 corner vs 悬空 corner 是稳定性概念的核心。
 */
export interface StabilityReport {
  com: Vec3 | null;
  isStable: boolean;
  /** Y 最低集合 在 XZ 平面投影的 footprint 顶点（CCW）。 */
  footprint: Array<[number, number]>;
}

export function analyzeStability(parts: StabilityPart[]): StabilityReport {
  if (parts.length === 0) {
    return { com: null, isStable: false, footprint: [] };
  }
  const com = computeCenterOfMass(parts);

  // 收集所有 part 的所有世界角点
  const allCorners: Vec3[] = [];
  for (const p of parts) {
    for (const c of partWorldCorners(p)) allCorners.push(c);
  }
  // 全局最低 Y
  let yMin = Infinity;
  for (const c of allCorners) {
    if (c[1] < yMin) yMin = c[1];
  }
  // contact 集合
  const contactPts: Array<[number, number]> = [];
  for (const c of allCorners) {
    if (c[1] - yMin <= CONTACT_Y_TOLERANCE_M) {
      contactPts.push([c[0], c[2]]);
    }
  }
  const footprint = convexHull2D(contactPts);

  if (com === null) return { com: null, isStable: false, footprint };
  const isStable = pointInConvexHull([com[0], com[2]], footprint);
  return { com, isStable, footprint };
}

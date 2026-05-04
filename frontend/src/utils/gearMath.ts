/**
 * gearMath.ts — L44 齿轮咬合相位对齐
 * ===================================
 * 当用户 snap 一个齿轮（已知 toothCount）后，扫描场景里其他齿轮，
 * 找到与之"轴线平行 + 中心距匹配齿数和"的潜在咬合伙伴，计算
 * 把 source 齿轮绕自身 Z 轴转到与 partner 咬合所需的最小角度增量。
 *
 * v1 简化：
 *   - 只支持外啮合（external mesh）平行轴齿轮。锥齿轮（bevel，轴交叉）、
 *     蜗轮蜗杆、齿条不在范围 —— 它们的 toothCount 提取要么失败要么走不同
 *     mesh 公式，本模块只做相位对齐到"齿尖指向 partner 中心"的最小转动。
 *   - "齿尖朝向 partner" 是约定假设。LDraw 实际"tooth 0"位置由各 .dat 决定，
 *     v1 不查 .dat 几何；视觉上最差偏半齿，仍远好于完全随机相位。
 *
 * 与 snapMath.ts 一样使用模块级 scratch 池，避免在 snapParts 热路径上分配 GC。
 */

import * as THREE from 'three';
import type { Vec3, Quat } from '../types';

// ─── LDraw 单位常量 ─────────────────────────────────────────────────────────
// 1 LDU = 0.4mm = 0.0004m；LEGO Technic 齿轮模数 module = 1L = 8 LDU。
// 中心距 d = (T_a + T_b) / 2 · module（外啮合）。
const LDU_TO_M = 0.0004;
export const LEGO_GEAR_MODULE_M = 8 * LDU_TO_M; // = 0.0032 m

// 数值容差 —— 浮点 + LDU 取整误差累计；2 LDU = 0.0008 m 经验值
const DIST_TOLERANCE_M = 0.001;
const PARALLEL_DOT_TOLERANCE = 0.999; // |Z_a · Z_b| > 此阈值视为平行
const COAXIAL_OFFSET_TOLERANCE_M = 0.0008; // 中心距投影到平面后 < 此值视为共轴

// ─── 模块级 scratch 池 ─────────────────────────────────────────────────────
// 不同函数的 scratch 命名前缀隔开（_axis_* / _check_* / _phase_* / _find_*），
// 避免循环或交叉调用时互相覆盖（findMeshPartnerAndDelta 在循环里调
// checkMeshGeometry，两边的 Vector3 必须不同）。
const _UNIT_Z = new THREE.Vector3(0, 0, 1);
const _axis_q = new THREE.Quaternion();
// 默认 scratch；调用方一般传自己的 out 避免循环间互覆，单点测试不传时回落到这个。
const _axis_default_out = new THREE.Vector3();

/** 返回某 quat 表示的旋转下，本地 +Z 在世界坐标里的方向（gear 轴向）。 */
export function getAxisWorld(
  quat: Quat,
  out: THREE.Vector3 = _axis_default_out,
): THREE.Vector3 {
  _axis_q.set(quat[0], quat[1], quat[2], quat[3]);
  return out.copy(_UNIT_Z).applyQuaternion(_axis_q);
}

/** 两条单位向量是否平行（不区分同向反向）。 */
export function axesParallel(a: THREE.Vector3, b: THREE.Vector3): boolean {
  return Math.abs(a.dot(b)) >= PARALLEL_DOT_TOLERANCE;
}

// checkMeshGeometry 专属 scratch
const _check_losW = new THREE.Vector3();
const _check_losPerp = new THREE.Vector3();

/**
 * 检查两个齿轮是否构成有效的外啮合配置。
 * 返回中心距投影到 axis-perpendicular 平面后的距离；不构成 mesh 时返 null。
 *
 * 几何要求：
 *   - 轴向平行
 *   - 中心连线沿轴向分量 ≈ 0（共平面）—— 不允许竖向错位的两齿轮在 v1 自动咬合
 *   - 平面内距离 ≈ (T_a + T_b)/2 · module ± tolerance
 */
export function checkMeshGeometry(
  posA: Vec3, axisA: THREE.Vector3,
  posB: Vec3, axisB: THREE.Vector3,
  toothA: number, toothB: number,
): number | null {
  if (!axesParallel(axisA, axisB)) return null;

  _check_losW.set(posB[0] - posA[0], posB[1] - posA[1], posB[2] - posA[2]);
  const losAlongAxis = _check_losW.dot(axisA);
  // 投影到 perpendicular 平面：losPerp = losW - (losW·axis)*axis
  _check_losPerp.copy(axisA).multiplyScalar(losAlongAxis);
  _check_losPerp.subVectors(_check_losW, _check_losPerp);
  const planarDist = _check_losPerp.length();

  // 共轴：planarDist ≈ 0 → 两齿轮在同根轴上独立旋转，没有机械咬合
  if (planarDist < COAXIAL_OFFSET_TOLERANCE_M) return null;
  // 沿轴向错位太多：v1 不算 mesh（实际 LEGO 也不会这样咬）
  if (Math.abs(losAlongAxis) > LEGO_GEAR_MODULE_M) return null;

  const expected = (toothA + toothB) / 2 * LEGO_GEAR_MODULE_M;
  if (Math.abs(planarDist - expected) > DIST_TOLERANCE_M) return null;
  return planarDist;
}

/**
 * 计算把 gear 绕自身轴向转到"齿尖指向 partner 中心"所需的最小角度（弧度）。
 * 正值 = CCW around gear's local +Z；负值 = CW。范围 (-π/T, +π/T]。
 *
 * 算法：
 *   1. 把"line of centers (gear -> partner)"投影到垂直 gear 轴的平面
 *   2. 转换到 gear 局部坐标系
 *   3. 当前局部 XY 平面里的角度 angleLocal 即"partner 在 gear 局部 +X 方向逆时针的角度"
 *   4. 我们想让齿尖（默认在 +X 方向，可能偏一齿）指向 partner，
 *      即 angleLocal_after_rotation 应在 {2πk / T} 的某一处
 *   5. 最小 delta = angleLocal - 最近的整数倍 2π/T
 */
// computePhaseDelta 专属 scratch
const _phase_losW = new THREE.Vector3();
const _phase_losLocal = new THREE.Vector3();
const _phase_q = new THREE.Quaternion();
const _phase_qInv = new THREE.Quaternion();

export function computePhaseDelta(
  gearWorldPos: Vec3,
  gearWorldQuat: Quat,
  partnerWorldPos: Vec3,
  toothCount: number,
): number {
  if (toothCount <= 0) return 0;

  // 1. line of centers in world
  _phase_losW.set(
    partnerWorldPos[0] - gearWorldPos[0],
    partnerWorldPos[1] - gearWorldPos[1],
    partnerWorldPos[2] - gearWorldPos[2],
  );

  // 2. 转到 gear 局部坐标系：losLocal = R^-1 · losW
  _phase_q.set(gearWorldQuat[0], gearWorldQuat[1], gearWorldQuat[2], gearWorldQuat[3]);
  _phase_qInv.copy(_phase_q).invert();
  _phase_losLocal.copy(_phase_losW).applyQuaternion(_phase_qInv);

  // 3. 局部 XY 平面里的角度（局部 +X 朝 partner 时 = 0）
  const angleLocal = Math.atan2(_phase_losLocal.y, _phase_losLocal.x);

  // 4. 找最近的齿槽（slot = 2π / T）
  const slot = (2 * Math.PI) / toothCount;
  const nearestK = Math.round(angleLocal / slot);
  let delta = angleLocal - nearestK * slot;

  // 5. 规整到 (-slot/2, slot/2]
  if (delta > slot / 2) delta -= slot;
  if (delta <= -slot / 2) delta += slot;
  return delta;
}

// ─── 应用旋转 ──────────────────────────────────────────────────────────────
// 模块级 scratch
const _qOrig = new THREE.Quaternion();
const _qLocalRot = new THREE.Quaternion();
const _qResult = new THREE.Quaternion();

/**
 * 把 gear 绕"它自己的 +Z 局部轴"原地旋转 deltaRad 弧度。
 * 等价于 q_new = q_orig · Rz(delta)（先按原姿态变到世界，再绕局部 Z 转）。
 * 位置不动 —— 齿轮在轴上自转不改变位置。
 */
export function rotateGearAroundOwnAxis(
  origQuat: Quat,
  deltaRad: number,
): Quat {
  _qOrig.set(origQuat[0], origQuat[1], origQuat[2], origQuat[3]);
  _qLocalRot.setFromAxisAngle(_UNIT_Z, deltaRad);
  _qResult.copy(_qOrig).multiply(_qLocalRot);
  return [_qResult.x, _qResult.y, _qResult.z, _qResult.w];
}

// ─── 端到端：扫描场景找咬合对，返回需要应用的相位增量 ───────────────────
export interface GearPart {
  partId: string;
  ldrawId: string;
  position: Vec3;
  quaternion: Quat;
  toothCount: number;
}

/**
 * 在 candidates 中扫描 source 的潜在 mesh partner；找到第一个匹配的就返回 delta。
 * 多个候选时取距离最接近预期 mesh distance 的那个。
 */
// findMeshPartnerAndDelta 专属 scratch（每次调用前 reset，循环内无 alloc）
const _find_axisSrc = new THREE.Vector3();
const _find_axisC = new THREE.Vector3();

export function findMeshPartnerAndDelta(
  source: GearPart,
  candidates: GearPart[],
): { partner: GearPart; delta: number } | null {
  getAxisWorld(source.quaternion, _find_axisSrc);

  let best: { partner: GearPart; delta: number; distErr: number } | null = null;
  for (const c of candidates) {
    if (c.partId === source.partId) continue;
    getAxisWorld(c.quaternion, _find_axisC);
    const planar = checkMeshGeometry(
      source.position, _find_axisSrc, c.position, _find_axisC,
      source.toothCount, c.toothCount,
    );
    if (planar === null) continue;

    const expected = (source.toothCount + c.toothCount) / 2 * LEGO_GEAR_MODULE_M;
    const distErr = Math.abs(planar - expected);
    if (best === null || distErr < best.distErr) {
      const delta = computePhaseDelta(
        source.position, source.quaternion, c.position, source.toothCount,
      );
      best = { partner: c, delta, distErr };
    }
  }
  if (!best) return null;
  return { partner: best.partner, delta: best.delta };
}

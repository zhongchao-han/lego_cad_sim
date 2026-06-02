/**
 * portSnap.ts
 * ===========
 * 「Port 磁吸对齐」纯函数：在自由放置 / 平移落定瞬间，把动件群整体平移到能让最多
 * (动 port, 静 port) 对落进 1mm 阈值的那一档，本身不修改任何 store 状态。
 *
 * 阈值分两段，对应人眼"差一点对上"和系统"算重合"两个不同语义：
 *   - search_radius = 8mm（1 stud）：找候选时"看得到"的最远距离
 *   - lock_threshold = 1mm：跟 relatchScan / auto_latch_scanner.AUTO_LATCH_THRESHOLD_M 同源
 *
 * 算法：
 *   1. 动件群所有 port、静止件所有 port 各自展平到世界坐标 + 世界法向。
 *   2. 对每对 (mp, sp)：要求法向反对（dot < -0.5，否则物理上没法对插）+ 距离 < search_radius。
 *   3. 候选 delta = sp.worldPos - mp.worldPos（把这一对挪到完全重合）。
 *   4. 评分：把整组平移 delta 之后，**所有**动 port 里能跟某个静 port 落进 lock_threshold
 *      且法向反对的对数。同一动 port 最多记一次（first match win）。
 *   5. 取分数最高 → 同分取 delta 最短（最小动作干扰）。无候选返 null。
 *
 * 不做极性互补校验：两个 FEMALE 孔挨在一起也算合法对齐目标（用户会自己塞销桥接），
 * 几何对齐 ≠ 自动建连。建连仍由调用方走 findRelatchEdges 的极性互补规则。
 */
import * as THREE from 'three';
import type { Vec3, Quat } from '../types';

/** 找候选的最远距离（米）：1 stud = 8mm。「视觉上差一点对上」的容差。 */
export const SNAP_SEARCH_RADIUS = 0.008;
/** 算"已重合"的阈值（米）：1mm，跟 relatchScan / backend AutoLatch 同源。 */
export const SNAP_LOCK_THRESHOLD = 0.001;
/** 法向反对的 dot 阈值：dot < -0.5 即 120° 内的"对插"方向。 */
const NORMAL_OPPOSITE_DOT = -0.5;

export interface SnapPartInput {
  id: string;
  ldrawId: string;
  position: Vec3;
  quaternion: Quat;
}

export interface SnapPortInput {
  /** 端口在 part 局部坐标系下的位置（米） */
  position: Vec3;
  /** 端口本地 3x3 旋转矩阵。第 3 列 = 端口"出向"轴（normal）。 */
  rotation: number[][];
}

interface WorldPort {
  partId: string;
  worldPos: Vec3;
  worldNormal: Vec3;
}

const _scratchV = new THREE.Vector3();
const _scratchQ = new THREE.Quaternion();

function rotateByQuat(v: Vec3, q: Quat): Vec3 {
  _scratchV.set(v[0], v[1], v[2]);
  _scratchQ.set(q[0], q[1], q[2], q[3]);
  _scratchV.applyQuaternion(_scratchQ);
  return [_scratchV.x, _scratchV.y, _scratchV.z];
}

function worldPortsOf(part: SnapPartInput, ports: SnapPortInput[]): WorldPort[] {
  const out: WorldPort[] = [];
  for (const p of ports) {
    const wp = rotateByQuat(p.position, part.quaternion);
    const ln: Vec3 = [p.rotation[0][2], p.rotation[1][2], p.rotation[2][2]];
    const wn = rotateByQuat(ln, part.quaternion);
    out.push({
      partId: part.id,
      worldPos: [
        wp[0] + part.position[0],
        wp[1] + part.position[1],
        wp[2] + part.position[2],
      ],
      worldNormal: wn,
    });
  }
  return out;
}

function dist3sq(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * 算最佳 magnetic snap 位移。
 *
 * @param movingParts      正在移动 / 放置的件群
 * @param staticParts      场景里其他静止件
 * @param portsByLdrawId   ldrawId → 端口几何（同 relatchScan）
 * @param options.searchRadius   候选最远距离（默认 8mm）
 * @param options.lockThreshold  算"已对齐"的阈值（默认 1mm）
 * @param options.userIntentDelta
 *   可选；用户本次平移意图位移（米）。提供后会过滤掉**反向拉用户**的候选：
 *   `dot(snap_delta, user_intent) < 0` 的 candidate 直接丢。
 *   防止"用户按 D 想 +8mm，snap 看到原位置 8mm 外有匹配 → 反拉 -8 → 净 0"
 *   这种"用户怎么按都动不了"的死锁。
 *   不提供（如自由放置落地、手动触发 relatch）时不过滤，保持老行为。
 * @returns delta 米（[dx,dy,dz]）或 null（无候选 / 全被反向过滤掉了）
 */
export function computeSnapDelta(
  movingParts: SnapPartInput[],
  staticParts: SnapPartInput[],
  portsByLdrawId: Record<string, SnapPortInput[]>,
  options?: { searchRadius?: number; lockThreshold?: number; userIntentDelta?: Vec3 },
): Vec3 | null {
  const searchRadius = options?.searchRadius ?? SNAP_SEARCH_RADIUS;
  const lockThreshold = options?.lockThreshold ?? SNAP_LOCK_THRESHOLD;
  const userIntentDelta = options?.userIntentDelta;
  const searchR2 = searchRadius * searchRadius;
  const lockR2 = lockThreshold * lockThreshold;
  // 用户意图非零时启用方向过滤；位移阈值 0.1mm，低于这个值视作"无意图"（如手动 0 平移触发）。
  const intentMag2 = userIntentDelta
    ? userIntentDelta[0]*userIntentDelta[0] + userIntentDelta[1]*userIntentDelta[1] + userIntentDelta[2]*userIntentDelta[2]
    : 0;
  const filterByIntent = intentMag2 > 1e-8; // (0.1mm)² = 1e-8 m²

  const movingPorts: WorldPort[] = [];
  for (const part of movingParts) {
    const ports = portsByLdrawId[part.ldrawId] || [];
    if (ports.length === 0) continue;
    movingPorts.push(...worldPortsOf(part, ports));
  }
  const staticPorts: WorldPort[] = [];
  for (const part of staticParts) {
    const ports = portsByLdrawId[part.ldrawId] || [];
    if (ports.length === 0) continue;
    staticPorts.push(...worldPortsOf(part, ports));
  }
  if (movingPorts.length === 0 || staticPorts.length === 0) return null;

  // 评分：动件群整体平移 delta 之后，能跟某个静 port 落进 lockThreshold 且法向反对的动 port 个数。
  // 每个动 port 至多记 1 次。
  const scoreDelta = (delta: Vec3): number => {
    let count = 0;
    for (const mp of movingPorts) {
      const sx = mp.worldPos[0] + delta[0];
      const sy = mp.worldPos[1] + delta[1];
      const sz = mp.worldPos[2] + delta[2];
      for (const sp of staticPorts) {
        if (dot3(mp.worldNormal, sp.worldNormal) > NORMAL_OPPOSITE_DOT) continue;
        const dx = sx - sp.worldPos[0];
        const dy = sy - sp.worldPos[1];
        const dz = sz - sp.worldPos[2];
        if (dx * dx + dy * dy + dz * dz < lockR2) {
          count += 1;
          break; // 同一动 port 不重复算
        }
      }
    }
    return count;
  };

  // 列候选：每个 (mp, sp) 法向反对 + 距离 < searchRadius 的对，都贡献一个候选 delta。
  type Candidate = { delta: Vec3; deltaLen2: number; score: number };
  const candidates: Candidate[] = [];
  for (const mp of movingPorts) {
    for (const sp of staticPorts) {
      if (dot3(mp.worldNormal, sp.worldNormal) > NORMAL_OPPOSITE_DOT) continue;
      const d2 = dist3sq(mp.worldPos, sp.worldPos);
      if (d2 > searchR2) continue;
      if (d2 < lockR2) continue; // 已经在 lock 阈值内 → delta 趋零，不必触发吸附
      const delta: Vec3 = [
        sp.worldPos[0] - mp.worldPos[0],
        sp.worldPos[1] - mp.worldPos[1],
        sp.worldPos[2] - mp.worldPos[2],
      ];
      // 方向过滤：禁止反向拉用户。用户按 D 想 +8mm，snap 不能算出 -8 把人拉回原位。
      // dot(snap_delta, user_intent) 必须 ≥ 0（同方向或垂直允许，反向丢）。
      if (filterByIntent) {
        const dotI = delta[0]*userIntentDelta![0] + delta[1]*userIntentDelta![1] + delta[2]*userIntentDelta![2];
        if (dotI < 0) continue;
      }
      candidates.push({ delta, deltaLen2: d2, score: 0 });
    }
  }
  if (candidates.length === 0) return null;

  // 给每个候选 delta 评分
  for (const c of candidates) c.score = scoreDelta(c.delta);

  // 排序：分数最高优先；同分取 delta 最短（最小动作干扰）。
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.deltaLen2 - b.deltaLen2;
  });

  // 候选自己 (mp 平移后落在 sp 上) 保证 score >= 1，所以 candidates[0].score 必 >= 1。
  return candidates[0].delta;
}

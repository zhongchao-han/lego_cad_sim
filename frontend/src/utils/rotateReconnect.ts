/**
 * rotateReconnect.ts
 * ==================
 * Feature A（UX 反馈）— 「只转选中的单件，相对其余装配」+ 旋转后自动微移重连 /
 * 失败脱开。纯几何，便于单测；store.rotateSelectedSingle 调用。
 *
 * 关键洞察：occupiedPorts 的 key 是端口在零件 **局部坐标系** 下的序列化坐标
 * （见 store.portKey），零件平移/旋转时局部 key 不变 —— 所以"保持"的连接无需
 * 重映射 key，只有"脱开"的连接需要清图。重连判定靠把局部端口坐标用 **新位姿**
 * 变换到世界系，看是否仍与对端端口世界坐标重合（< 阈值 ≈ 1mm）。
 *
 * 设计语义（用户确认）：
 *   1. 绕零件自身竖直轴（世界 Y）转，pivot = 零件包围盒中心（无则用原点）。
 *   2. 转完先尝试一次"整体微移"对齐：t = 对端端口质心 − 本件端口质心（旋转后）。
 *   3. 应用 t 后逐 peer 校验：本件那一侧所有占用端口都能在阈值内找到对端端口 →
 *      该 peer 连接保持；否则该 peer 脱开。
 *   4. 若微移后一个 peer 都保不住 → 不微移（t=0），仅保留旋转，全部脱开。
 */

import * as THREE from 'three';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface RigidPose {
  position: Vec3;
  quaternion: Quat;
}

// ─── 对象池（热路径复用，避免 GC 尖刺；JS 单线程 + 同步非递归即安全）────────────
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/**
 * 解析 portKey 的局部坐标部分。
 * 格式："x,y,z" 或 "x,y,z|zx,zy,zz"（见 store.portKey）。解析失败返 null。
 */
export function parsePortKeyPos(key: string): Vec3 | null {
  const base = key.split('|')[0];
  const parts = base.split(',');
  if (parts.length !== 3) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/** 端口局部坐标 → 世界坐标：world = pos + quat·local。 */
export function portWorldPos(pose: RigidPose, local: Vec3): Vec3 {
  _v.set(local[0], local[1], local[2]);
  _q.set(pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]);
  _v.applyQuaternion(_q);
  return [_v.x + pose.position[0], _v.y + pose.position[1], _v.z + pose.position[2]];
}

/**
 * 绕世界 pivot 旋转零件：newQuat = axisAngle(axis,angle)⊗quat；位置随 pivot 公转。
 */
export function rotatePartAboutPivot(
  pose: RigidPose,
  pivot: Vec3,
  axis: Vec3,
  angle: number,
): RigidPose {
  _axis.set(axis[0], axis[1], axis[2]).normalize();
  _dq.setFromAxisAngle(_axis, angle);
  // 新朝向（世界轴预乘）
  _q.set(pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]);
  const nq = _dq.clone().multiply(_q);
  // 位置：rel = pos − pivot；newRel = dq·rel；newPos = pivot + newRel
  _v.set(pose.position[0] - pivot[0], pose.position[1] - pivot[1], pose.position[2] - pivot[2]);
  _v.applyQuaternion(_dq);
  return {
    position: [_v.x + pivot[0], _v.y + pivot[1], _v.z + pivot[2]],
    quaternion: [nq.x, nq.y, nq.z, nq.w],
  };
}

/** 世界 pivot = 零件原点 + quat·bboxCenterLocal（无 bboxCenter 时即原点）。 */
export function worldPivot(pose: RigidPose, bboxCenterLocal: Vec3 | null): Vec3 {
  if (!bboxCenterLocal) return [...pose.position];
  return portWorldPos(pose, bboxCenterLocal);
}

function dist2(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function centroid(pts: Vec3[]): Vec3 {
  if (pts.length === 0) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
  const n = pts.length;
  return [x / n, y / n, z / n];
}

/**
 * 贪心最近匹配：本件端口集 src 的每一个，是否都能在对端集 dst 里找到 < thr 的
 * 配对（一对一，已配走的不重用）。全部配上才算"对齐"。
 */
function allMatched(src: Vec3[], dst: Vec3[], thr: number): boolean {
  if (src.length === 0) return false;
  const thr2 = thr * thr;
  const used = new Array(dst.length).fill(false);
  for (const s of src) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < dst.length; j++) {
      if (used[j]) continue;
      const d = dist2(s, dst[j]);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best < 0 || bestD > thr2) return false;
    used[best] = true;
  }
  return true;
}

export interface ReconnectResult {
  /** 旋转（+ 可能的微移）后的最终位姿。 */
  newPose: RigidPose;
  /** 实际施加的微移平移量（世界系，米）。 */
  autoMove: Vec3;
  /** 连接保持的 peer。 */
  keptPeers: string[];
  /** 连接脱开的 peer。 */
  detachedPeers: string[];
}

export interface RotateReconnectArgs {
  /** 被转零件的旧位姿。 */
  oldPose: RigidPose;
  /** 世界 pivot（通常 = worldPivot(oldPose, bboxCenterLocal)）。 */
  pivot: Vec3;
  axis: Vec3;
  angle: number;
  /** 被转零件 ID（用于在 peerOccupied 里反查指向自己的端口）。 */
  partId: string;
  /** occupiedPorts[partId]：localKey → peerId。 */
  occupiedByPart: Record<string, string>;
  /** peerId → 该 peer 的位姿。 */
  peerPoses: Record<string, RigidPose>;
  /** occupiedPorts[peerId]：localKey → ownerId。 */
  peerOccupied: Record<string, Record<string, string>>;
  /** 重合阈值（米），默认 1mm（对齐 backend auto-latch）。 */
  threshold?: number;
}

/**
 * 旋转后重连/脱开决策（纯函数）。见文件头语义说明。
 */
export function evaluateRotateReconnect(args: RotateReconnectArgs): ReconnectResult {
  const { oldPose, pivot, axis, angle, partId, occupiedByPart, peerPoses, peerOccupied } = args;
  const threshold = args.threshold ?? 0.001;

  const rotated = rotatePartAboutPivot(oldPose, pivot, axis, angle);

  // 本件端口（旋转后世界坐标），按 peer 分组。
  const srcByPeer: Record<string, Vec3[]> = {};
  for (const [key, peer] of Object.entries(occupiedByPart)) {
    const local = parsePortKeyPos(key);
    if (!local) continue;
    (srcByPeer[peer] ??= []).push(portWorldPos(rotated, local));
  }

  // 对端端口（指向本件的那些，世界坐标，不动），按 peer 分组。
  const dstByPeer: Record<string, Vec3[]> = {};
  for (const peer of Object.keys(srcByPeer)) {
    const occ = peerOccupied[peer];
    const pose = peerPoses[peer];
    if (!occ || !pose) { dstByPeer[peer] = []; continue; }
    const list: Vec3[] = [];
    for (const [key, owner] of Object.entries(occ)) {
      if (owner !== partId) continue;
      const local = parsePortKeyPos(key);
      if (!local) continue;
      list.push(portWorldPos(pose, local));
    }
    dstByPeer[peer] = list;
  }

  // 微移量 t = 全部对端端口质心 − 全部本件端口质心（旋转后）。
  const allSrc: Vec3[] = [];
  const allDst: Vec3[] = [];
  for (const peer of Object.keys(srcByPeer)) {
    allSrc.push(...srcByPeer[peer]);
    allDst.push(...dstByPeer[peer]);
  }
  const cs = centroid(allSrc);
  const cd = centroid(allDst);
  let t: Vec3 = allDst.length > 0
    ? [cd[0] - cs[0], cd[1] - cs[1], cd[2] - cs[2]]
    : [0, 0, 0];

  const evalWith = (tt: Vec3) => {
    const kept: string[] = [];
    const detached: string[] = [];
    for (const peer of Object.keys(srcByPeer)) {
      const src = srcByPeer[peer].map((p): Vec3 => [p[0] + tt[0], p[1] + tt[1], p[2] + tt[2]]);
      if (allMatched(src, dstByPeer[peer], threshold)) kept.push(peer);
      else detached.push(peer);
    }
    return { kept, detached };
  };

  let { kept, detached } = evalWith(t);
  // 微移一个都保不住 → 放弃微移，仅保留旋转，全部脱开。
  if (kept.length === 0) {
    t = [0, 0, 0];
    ({ kept, detached } = evalWith(t));
  }

  return {
    newPose: {
      position: [rotated.position[0] + t[0], rotated.position[1] + t[1], rotated.position[2] + t[2]],
      quaternion: rotated.quaternion,
    },
    autoMove: t,
    keptPeers: kept.sort(),
    detachedPeers: detached.sort(),
  };
}

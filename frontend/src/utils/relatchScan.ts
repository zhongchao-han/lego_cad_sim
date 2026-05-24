/**
 * relatchScan.ts
 * ==============
 * 「检测并连接」纯几何核心：扫全场，找**端口几何重合且极性互补（孔↔插）**、但在连接图里
 * 尚未连上的端口对 —— 即"看着插进去了却没建连"的件。返回应建立的连接边，副作用（写
 * connections / occupiedPorts、可撤销）由调用方 store.relatchScene 处理。
 *
 * 与后端 AutoLatchScanner 同语义（孔↔插 + 距离阈值），但纯前端：复用 /api/ldraw_part
 * 已缓存的端口几何，不依赖新后端端点，避免主仓后端不同步 / 需重启的摩擦。
 */
import * as THREE from 'three';
import type { Vec3, Quat } from '../types';

export interface RelatchPartInput {
  id: string;
  ldrawId: string;
  position: Vec3;
  quaternion: Quat;
}

export interface RelatchPortInput {
  position: Vec3;        // 局部坐标
  rotation: number[][];  // 3x3
  type?: string;
  gender?: string | null;
}

export interface RelatchEdge {
  a: string;        // 实例 id
  b: string;        // 实例 id
  aPortKey: string; // a 侧端口 key（portKey(localPos, rotation)）
  bPortKey: string; // b 侧端口 key
}

/** 极性：显式 gender 优先，否则按 type 名含 'hol' 判母（与 SiteGizmo.isFemale 同规则）。 */
export function relatchPortIsFemale(p: RelatchPortInput): boolean {
  if (p.gender) return p.gender === 'FEMALE';
  const t = (p.type || '').toLowerCase();
  return t.includes('hol');
}

/**
 * 找出应「补建」的连接边：端口世界坐标重合（< threshold）+ 极性互补（一孔一插）+ 件对
 * 尚未连接。
 *
 * @param parts            场景零件（实例 id + ldrawId + 世界位姿）
 * @param portsByLdrawId   ldrawId → 该类零件的端口几何列表（局部坐标）
 * @param existingPairs    已连接的件对集合（"a|b" 升序拼接）
 * @param portKeyFn        store.portKey：(局部坐标, rotation) → key（与 occupiedPorts 对齐）
 * @param threshold        重合阈值（米），默认 1mm（对齐后端 AutoLatch）
 */
export function findRelatchEdges(
  parts: RelatchPartInput[],
  portsByLdrawId: Record<string, RelatchPortInput[]>,
  existingPairs: Set<string>,
  portKeyFn: (pos: Vec3, rot: number[][]) => string,
  threshold = 0.001,
): RelatchEdge[] {
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();

  // 预算每个零件的世界端口（坐标 + 极性 + key）。
  const worldPortsOf = (part: RelatchPartInput) => {
    const ports = portsByLdrawId[part.ldrawId] || [];
    _q.set(part.quaternion[0], part.quaternion[1], part.quaternion[2], part.quaternion[3]);
    return ports.map((p) => {
      _v.set(p.position[0], p.position[1], p.position[2]).applyQuaternion(_q);
      return {
        world: [_v.x + part.position[0], _v.y + part.position[1], _v.z + part.position[2]] as Vec3,
        female: relatchPortIsFemale(p),
        key: portKeyFn(p.position, p.rotation),
      };
    });
  };

  const wp = parts.map(worldPortsOf);
  const thr2 = threshold * threshold;
  const edges: RelatchEdge[] = [];
  // 每条「件对 + 端口对」只记一次。
  const seen = new Set<string>();

  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const pairKey = [parts[i].id, parts[j].id].sort().join('|');
      if (existingPairs.has(pairKey)) continue;
      for (const pa of wp[i]) {
        for (const pb of wp[j]) {
          if (pa.female === pb.female) continue; // 必须一孔一插
          const dx = pa.world[0] - pb.world[0];
          const dy = pa.world[1] - pb.world[1];
          const dz = pa.world[2] - pb.world[2];
          if (dx * dx + dy * dy + dz * dz > thr2) continue;
          const ek = `${pairKey}#${pa.key}#${pb.key}`;
          if (seen.has(ek)) continue;
          seen.add(ek);
          edges.push({ a: parts[i].id, b: parts[j].id, aPortKey: pa.key, bPortKey: pb.key });
        }
      }
    }
  }
  return edges;
}

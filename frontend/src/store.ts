import { create } from 'zustand';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000/api';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // [x, y, z, w]
type Mat3 = number[][] | number[];

interface PartState {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

type ConnectionGraph = Record<string, Set<string>>;

type FocusMode = 'part' | 'port' | null;

interface StoreState {
  mode: 'ASSEMBLY' | 'SIMULATION';
  parts: Record<string, PartState>;
  connections: ConnectionGraph;
  wsConnected: boolean;
  selectedPort: SelectedPortInfo | null;
  useLDraw: boolean;
  focusedPartId: string | null;
  focusMode: FocusMode;
  showPortGizmos: boolean;
  enableFocusAnimation: boolean;
  toggleMode: () => Promise<void>;
  updatePartState: (partId: string, state: PartState) => void;
  setWsConnected: (status: boolean) => void;
  setSelectedPort: (port: SelectedPortInfo | null) => void;
  snapParts: (source: SelectedPortInfo, target: SelectedPortInfo) => Promise<boolean>;
  setUseLDraw: (value: boolean) => void;
  setFocus: (payload: { partId: string | null; mode: FocusMode }) => void;
  setShowPortGizmos: (value: boolean) => void;
  setEnableFocusAnimation: (value: boolean) => void;
}

export interface SelectedPortInfo {
  partId: string;
  portType: string;
  position: Vec3;
  rotation: Mat3;
  globalPos: Vec3;
}

// ==================== 向量 / 四元数工具 ====================

const vecAdd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vecSub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vecDot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vecCross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vecLength = (a: Vec3): number => Math.sqrt(vecDot(a, a));
const vecNormalize = (a: Vec3): Vec3 => {
  const len = vecLength(a);
  if (len === 0) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
};
const vecScale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

const mat3MulVec3 = (m: Mat3 | undefined, v: Vec3): Vec3 => {
  if (!m) return v;
  if (Array.isArray(m[0])) {
    const mm = m as number[][];
    if (mm.length < 3 || mm[0].length < 3) return v;
    return [
      mm[0][0] * v[0] + mm[0][1] * v[1] + mm[0][2] * v[2],
      mm[1][0] * v[0] + mm[1][1] * v[1] + mm[1][2] * v[2],
      mm[2][0] * v[0] + mm[2][1] * v[1] + mm[2][2] * v[2],
    ];
  }
  const flat = m as number[];
  if (flat.length < 9) return v;
  return [
    flat[0] * v[0] + flat[1] * v[1] + flat[2] * v[2],
    flat[3] * v[0] + flat[4] * v[1] + flat[5] * v[2],
    flat[6] * v[0] + flat[7] * v[1] + flat[8] * v[2],
  ];
};

const quatNormalize = (q: Quat): Quat => {
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (len === 0) return [0, 0, 0, 1];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
};

const quatMultiply = (a: Quat, b: Quat): Quat => {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
};

const quatApplyToVec3 = (q: Quat, v: Vec3): Vec3 => {
  const x = v[0], y = v[1], z = v[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
};

const quatFromUnitVectors = (from: Vec3, to: Vec3): Quat => {
  const v1 = vecNormalize(from);
  const v2 = vecNormalize(to);
  const dot = vecDot(v1, v2);
  if (dot > 0.99999) return [0, 0, 0, 1];
  if (dot < -0.99999) {
    const axis = vecNormalize(
      Math.abs(v1[0]) > 0.1 ? vecCross([0, 1, 0], v1) : vecCross([1, 0, 0], v1),
    );
    return [axis[0], axis[1], axis[2], 0]; // 180° rotation
  }
  const axis = vecCross(v1, v2);
  const s = Math.sqrt((1 + dot) * 2);
  const invS = 1 / s;
  return quatNormalize([axis[0] * invS, axis[1] * invS, axis[2] * invS, s * 0.5]);
};

const flatRot = (r: Mat3): number[] =>
  Array.isArray(r[0]) ? (r as number[][]).flat() : (r as number[]);

function getConnectedGroup(connections: ConnectionGraph, startId: string, excludeId: string): string[] {
  const visited = new Set<string>();
  const queue = [startId];
  visited.add(startId);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = connections[current];
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor) && neighbor !== excludeId) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }
  return Array.from(visited);
}

export const useStore = create<StoreState>((set, get) => ({
  mode: 'ASSEMBLY',
  parts: {
    "32524": { position: [0, 0.005, 0], quaternion: [0, 0, 0, 1] },
    "32523": { position: [0.03, 0.005, 0.04], quaternion: [0, 0, 0, 1] },
    "6558": { position: [-0.03, 0.03, 0], quaternion: [0, 0, 0, 1] },
  },
  connections: {},
  wsConnected: false,
  selectedPort: null,
  useLDraw: false,
  focusedPartId: null,
  focusMode: null,
  showPortGizmos: true,
  enableFocusAnimation: true,

  toggleMode: async () => {
    const currentMode = get().mode;
    const nextMode = currentMode === 'ASSEMBLY' ? 'SIMULATION' : 'ASSEMBLY';
    try {
      await axios.post(`${API_URL}/toggle_mode?mode=${nextMode}`);
      set({ mode: nextMode, selectedPort: null });
    } catch (e) {
      console.error("Failed to toggle mode:", e);
    }
  },

  updatePartState: (partId, state) => set((prev) => ({
    parts: { ...prev.parts, [partId]: state }
  })),

  setWsConnected: (status) => set({ wsConnected: status }),
  setSelectedPort: (port) => set({ selectedPort: port }),
  setUseLDraw: (value) => set({ useLDraw: value }),
  setFocus: ({ partId, mode }) => set({ focusedPartId: partId, focusMode: mode }),
  setShowPortGizmos: (value) => set({ showPortGizmos: value }),
  setEnableFocusAnimation: (value) => set({ enableFocusAnimation: value }),

  // =================================================================
  // snapParts — 完全基于零件几何形状的插入逻辑
  //
  // 已知几何事实（来自 createBeamGeometry / cylinderGeometry）：
  //   梁: 沿 X 展开，孔沿 Y 贯穿，梁厚 ±10*LDU(Y)，梁高 ±10*LDU(Z)
  //        孔中心在本地 [X_i, 0, 0]
  //        端口放在孔入口 [X_i, 10*LDU, 0]（梁顶面）
  //
  //   插销: 圆柱沿 Y，半长 16*LDU，中心在本地 [0, 0, 0]
  //         端口放在端面 [0, ±16*LDU, 0]
  //
  // 插入 = 1) 旋转插销使其轴向对齐孔轴向
  //         2) 平移使插销几何中心对齐孔几何中心
  //
  // "几何中心" = 端口位置去掉沿轴方向的分量
  //   梁孔: [X_i, 10*LDU, 0] 去掉 Y 分量 → [X_i, 0, 0]  ✓
  //   插销: [0, ±16*LDU, 0] 去掉 Y 分量 → [0, 0, 0]       ✓
  // =================================================================

  snapParts: async (source, target) => {
    const parts = get().parts;
    const connections = get().connections;
    const group = getConnectedGroup(connections, source.partId, target.partId);

    const sourcePart = parts[source.partId];
    const targetPart = parts[target.partId];
    if (!sourcePart || !targetPart) return false;

    const baseAxis: Vec3 = [0, 1, 0];

    // 端口本地轴向（经端口旋转矩阵变换后的 +Y）
    const srcAxisLocal = mat3MulVec3(source.rotation, baseAxis);
    const tgtAxisLocal = mat3MulVec3(target.rotation, baseAxis);

    // 世界轴向
    const srcAxisWorld = vecNormalize(quatApplyToVec3(sourcePart.quaternion, srcAxisLocal));
    const tgtAxisWorld = vecNormalize(quatApplyToVec3(targetPart.quaternion, tgtAxisLocal));

    // ---- Step 1: 旋转插销组，使插销轴对齐孔轴 ----
    const qDelta = quatFromUnitVectors(srcAxisWorld, tgtAxisWorld);
    const pivot: Vec3 = sourcePart.position;
    const updated: Record<string, PartState> = { ...parts };

    for (const pid of group) {
      const part = updated[pid];
      if (!part) continue;
      const rel = vecSub(part.position, pivot);
      const relRot = quatApplyToVec3(qDelta, rel);
      updated[pid] = {
        position: vecAdd(pivot, relRot),
        quaternion: quatNormalize(quatMultiply(qDelta, part.quaternion)),
      };
    }

    // ---- Step 2: 计算对齐目标点 ----
    //
    // target 是 peghole（孔）→ 去掉轴向分量得到孔的几何中心
    //   例：梁端口 [X, 10*LDU, 0] → 孔中心 [X, 0, 0]
    //
    // target 是 peg（插销端面）→ 直接用端口位置（端面点）
    //   例：插销端口 [0, -16*LDU, 0] → 就用这个点
    //   这样第二根梁会对齐到插销的端面而不是中心，避免与第一根梁重合

    let targetAlignLocal: Vec3;
    if (target.portType === 'peg') {
      targetAlignLocal = target.position;
    } else {
      const tgtDot = vecDot(target.position, tgtAxisLocal);
      targetAlignLocal = vecSub(target.position, vecScale(tgtAxisLocal, tgtDot));
    }
    const targetAlignWorld = vecAdd(
      targetPart.position,
      quatApplyToVec3(targetPart.quaternion, targetAlignLocal),
    );

    // source 始终去掉轴向分量，得到零件几何中心
    const srcDot = vecDot(source.position, srcAxisLocal);
    const sourceBodyLocal: Vec3 = vecSub(source.position, vecScale(srcAxisLocal, srcDot));
    const rotatedSource = updated[source.partId]!;
    const sourceBodyWorld = vecAdd(
      rotatedSource.position,
      quatApplyToVec3(rotatedSource.quaternion, sourceBodyLocal),
    );

    // ---- Step 3: 平移整组 ----
    const delta = vecSub(targetAlignWorld, sourceBodyWorld);
    for (const pid of group) {
      const part = updated[pid];
      if (!part) continue;
      updated[pid] = { ...part, position: vecAdd(part.position, delta) };
    }

    // ---- Step 4: 更新状态 ----
    const newConnections = { ...connections };
    if (!newConnections[source.partId]) newConnections[source.partId] = new Set();
    if (!newConnections[target.partId]) newConnections[target.partId] = new Set();
    newConnections[source.partId] = new Set(newConnections[source.partId]).add(target.partId);
    newConnections[target.partId] = new Set(newConnections[target.partId]).add(source.partId);

    set({
      parts: updated,
      connections: newConnections,
      selectedPort: null,
    });

    console.log(`✅ Snap: ${source.partId} 插入 ${target.partId}（几何中心对齐）`);

    // 通知后端记录拓扑
    try {
      await axios.post(`${API_URL}/snap_parts`, {
        parent_id: target.partId,
        child_id: source.partId,
        port_type_p: target.portType,
        port_type_c: source.portType,
        parent_origin: target.position,
        parent_rot: flatRot(target.rotation),
        child_origin: source.position,
        child_rot: flatRot(source.rotation),
      });
    } catch (e) {
      console.error("Snap topo sync failed:", e);
    }

    return true;
  }
}));

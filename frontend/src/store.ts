import { create } from 'zustand';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000/api';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // [x, y, z, w]
type Mat3 = number[][] | number[];

interface PartState {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  colorCode?: number;
  stress?: number; // 物理应力
}

type ConnectionGraph = Record<string, Set<string>>;

type FocusMode = 'part' | 'port' | null;

interface StoreState {
  mode: 'ASSEMBLY' | 'SIMULATION';
  parts: Record<string, PartState>;
  connections: ConnectionGraph;
  wsConnected: boolean;
  selectedPort: SelectedPortInfo | null;
  focusedPartId: string | null;
  focusMode: FocusMode;
  showPortGizmos: boolean;
  enableFocusAnimation: boolean;
  enableSSAO: boolean;
  enableContactShadows: boolean;
  toggleMode: () => Promise<void>;
  updatePartState: (partId: string, state: PartState) => void;
  batchUpdatePartStates: (updates: Record<string, PartState>) => void;
  setWsConnected: (status: boolean) => void;
  setSelectedPort: (port: SelectedPortInfo | null) => void;
  snapParts: (source: SelectedPortInfo, target: SelectedPortInfo) => Promise<boolean>;
  setFocus: (payload: { partId: string | null; mode: FocusMode }) => void;
  setShowPortGizmos: (value: boolean) => void;
  setEnableFocusAnimation: (value: boolean) => void;
  setEnableSSAO: (value: boolean) => void;
  setEnableContactShadows: (value: boolean) => void;
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
    "32524": { position: [0, 0.005, 0], quaternion: [0, 0, 0, 1], colorCode: 4 },
    "32523": { position: [0.03, 0.005, 0.04], quaternion: [0, 0, 0, 1], colorCode: 1 },
    "6558": { position: [-0.03, 0.03, 0], quaternion: [0, 0, 0, 1], colorCode: 0 },
  },
  connections: {},
  wsConnected: false,
  selectedPort: null,
  focusedPartId: null,
  focusMode: null,
  showPortGizmos: true,
  enableFocusAnimation: true,
  enableSSAO: false,
  enableContactShadows: false,

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

  batchUpdatePartStates: (updates) => set((prev) => {
    const newParts = { ...prev.parts };
    for (const [id, newState] of Object.entries(updates)) {
        if (newParts[id]) {
            newParts[id] = { ...newParts[id], ...newState };
        } else {
            newParts[id] = newState as PartState;
        }
    }
    return { parts: newParts };
  }),

  setWsConnected: (status) => set({ wsConnected: status }),
  setSelectedPort: (port) => set({ selectedPort: port }),
  setFocus: ({ partId, mode }) => set({ focusedPartId: partId, focusMode: mode }),
  setShowPortGizmos: (value) => set({ showPortGizmos: value }),
  setEnableFocusAnimation: (value) => set({ enableFocusAnimation: value }),
  setEnableSSAO: (value) => set({ enableSSAO: value }),
  setEnableContactShadows: (value) => set({ enableContactShadows: value }),

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

    const sourcePart = parts[source.partId];
    const targetPart = parts[target.partId];
    if (!sourcePart || !targetPart) return false;

    const baseAxis: Vec3 = [0, 1, 0];
    const srcAxisLocal = mat3MulVec3(source.rotation, baseAxis);
    const tgtAxisLocal = mat3MulVec3(target.rotation, baseAxis);
    const srcAxisWorld = vecNormalize(quatApplyToVec3(sourcePart.quaternion, srcAxisLocal));
    const tgtAxisWorld = vecNormalize(quatApplyToVec3(targetPart.quaternion, tgtAxisLocal));

    const isPegIntoHole = source.portType === 'peg' && target.portType === 'peghole';
    const srcConnected = (connections[source.partId]?.size ?? 0) > 0;

    const stripAxis = (pos: Vec3, axis: Vec3): Vec3 => {
      const d = vecDot(pos, axis);
      return vecSub(pos, vecScale(axis, d));
    };

    const updated: Record<string, PartState> = { ...parts };

    // 当插销已有连接时，保持插销+已连接梁不动，移动新的梁到插销上
    const moveTargetToSource = srcConnected && isPegIntoHole;

    if (moveTargetToSource) {
      // ===== 第二次插入：移动目标梁到插销 =====
      const tgtGroup = getConnectedGroup(connections, target.partId, source.partId);

      // 旋转梁使其孔轴与插销轴反向对齐（孔口朝向插销）
      const qDelta = quatFromUnitVectors(tgtAxisWorld, vecScale(srcAxisWorld, -1) as Vec3);
      const pivot: Vec3 = targetPart.position;

      for (const pid of tgtGroup) {
        const part = updated[pid];
        if (!part) continue;
        const rel = vecSub(part.position, pivot);
        const relRot = quatApplyToVec3(qDelta, rel);
        updated[pid] = {
          position: vecAdd(pivot, relRot),
          quaternion: quatNormalize(quatMultiply(qDelta, part.quaternion)),
        };
      }

      // 平移：梁的端口（表面）对齐到插销的几何中心
      const srcAlignLocal = stripAxis(source.position, srcAxisLocal);
      const srcAlignWorld = vecAdd(
        sourcePart.position,
        quatApplyToVec3(sourcePart.quaternion, srcAlignLocal),
      );

      const rotatedTarget = updated[target.partId]!;
      const tgtAlignWorld = vecAdd(
        rotatedTarget.position,
        quatApplyToVec3(rotatedTarget.quaternion, target.position),
      );

      const delta = vecSub(srcAlignWorld, tgtAlignWorld);
      for (const pid of tgtGroup) {
        const part = updated[pid];
        if (!part) continue;
        updated[pid] = { ...part, position: vecAdd(part.position, delta) };
      }

    } else {
      // ===== 首次插入：移动插销（源）到目标梁 =====
      const srcGroup = getConnectedGroup(connections, source.partId, target.partId);

      const effectiveSrcAxis: Vec3 = isPegIntoHole
        ? vecScale(srcAxisWorld, -1) as Vec3
        : srcAxisWorld;
      const qDelta = quatFromUnitVectors(effectiveSrcAxis, tgtAxisWorld);
      const pivot: Vec3 = sourcePart.position;

      for (const pid of srcGroup) {
        const part = updated[pid];
        if (!part) continue;
        const rel = vecSub(part.position, pivot);
        const relRot = quatApplyToVec3(qDelta, rel);
        updated[pid] = {
          position: vecAdd(pivot, relRot),
          quaternion: quatNormalize(quatMultiply(qDelta, part.quaternion)),
        };
      }

      const targetAlignLocal = target.portType === 'peg'
        ? target.position
        : stripAxis(target.position, tgtAxisLocal);
      const targetAlignWorld = vecAdd(
        targetPart.position,
        quatApplyToVec3(targetPart.quaternion, targetAlignLocal),
      );

      const sourceAlignLocal = stripAxis(source.position, srcAxisLocal);
      const rotatedSource = updated[source.partId]!;
      const sourceAlignWorld = vecAdd(
        rotatedSource.position,
        quatApplyToVec3(rotatedSource.quaternion, sourceAlignLocal),
      );

      const delta = vecSub(targetAlignWorld, sourceAlignWorld);
      for (const pid of srcGroup) {
        const part = updated[pid];
        if (!part) continue;
        updated[pid] = { ...part, position: vecAdd(part.position, delta) };
      }
    }

    // 物理插入检测（仅 peg→peghole）
    if (isPegIntoHole) {
      try {
        const res = await axios.get(`${API_URL}/insertion_check`, {
          params: { peg_id: source.partId, hole_id: target.partId },
        });
        const d = res.data;
        const fitLabels: Record<string, string> = {
          clearance: '间隙配合', friction: '摩擦配合', interference: '过盈配合', blocked: '不可插入',
        };
        const fit = fitLabels[d.fit_type] || d.fit_type;
        if (d.can_fully_insert) {
          console.log(
            `[physics] ✅ ${fit} | 过盈=${d.interference_mm}mm(${d.interference_pct}%) ` +
            `| 插销=[${d.peg_min_radius*1000}, ${d.peg_max_radius*1000}]mm 孔径=${d.hole_radius*1000}mm`,
          );
        } else {
          console.warn(`[physics] ❌ ${fit} | 不能完全插入 (${d.max_passable_length*1000}mm < 梁厚${d.beam_thickness*1000}mm)`);
        }
      } catch (e) {
        console.warn('[physics] insertion_check failed:', e);
      }
    }

    // 更新连接图和状态
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

    const label = moveTargetToSource ? '梁→插销' : '插销→梁';
    console.log(`✅ Snap [${label}]: ${source.partId} ↔ ${target.partId}`);

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

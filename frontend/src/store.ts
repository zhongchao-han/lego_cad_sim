import { create } from 'zustand';
import axios from 'axios';
import { InteractionPhase, isValidTransition, InteractionEvents } from './interactionFSM';
import { ZoneType, StagingGrid } from './staging';
import { HistoryStack, createSnapCommand, SnapSnapshot } from './historyStack';

export { InteractionPhase, ZoneType };

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type Mat3 = number[][] | number[];

interface PartState {
  ldrawId: string;
  position: Vec3;
  quaternion: Quat;
  colorCode: number;
  zone: ZoneType;
}

type ConnectionGraph = Record<string, Set<string>>;

interface StoreState {
  mode: 'ASSEMBLY' | 'SIMULATION';
  view: 'ASSEMBLY' | 'LIBRARY_VERIFY';
  parts: Record<string, PartState>;
  connections: ConnectionGraph;
  wsConnected: boolean;
  selectedPort: SelectedPortInfo | null;
  interactionPhase: InteractionPhase;
  focusedPartId: string | null;
  focusMode: 'part' | 'assembly' | null;
  showPortGizmos: boolean;
  enableFocusAnimation: boolean;
  enableSSAO: boolean;
  enableContactShadows: boolean;
  debugMode: boolean;
  previewPartId: string | null;
  
  // Actions
  setView: (view: 'ASSEMBLY' | 'LIBRARY_VERIFY') => void;
  toggleMode: () => Promise<void>;
  updatePartState: (partId: string, state: Partial<PartState>) => void;
  batchUpdatePartStates: (updates: Record<string, Partial<PartState>>) => void;
  setWsConnected: (status: boolean) => void;
  handlePortClick: (port: SelectedPortInfo) => Promise<void>;
  snapParts: (source: SelectedPortInfo, target: SelectedPortInfo) => Promise<boolean>;
  setFocus: (params: { partId: string | null; mode: 'part' | 'assembly' | null }) => void;
  setShowPortGizmos: (value: boolean) => void;
  setEnableFocusAnimation: (value: boolean) => void;
  setEnableSSAO: (value: boolean) => void;
  setEnableContactShadows: (value: boolean) => void;
  setDebugMode: (value: boolean) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  setPartZone: (partId: string, zone: ZoneType) => void;
  stagingGrid: StagingGrid;
  previewPart: (partId: string) => void;
  
  /** 拆卸某个零件及其所有连接，并将其移动至暂存区 */
  stagePart: (partId: string) => void;
}

export interface SelectedPortInfo {
  partId: string; // 实例唯一 ID (Instance ID)
  ldrawId: string; // 原始 .dat ID
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

// ---------------------------------------------------------------------------
// 模块级 HistoryStack（生命周期与 store 相同）
// ---------------------------------------------------------------------------
const _history = new HistoryStack(50);

// ---------------------------------------------------------------------------
// Zustand Store
// ---------------------------------------------------------------------------

export const useStore = create<StoreState>((set, get) => ({
  mode: 'ASSEMBLY',
  view: 'ASSEMBLY',
  parts: {
    "32524.dat": { ldrawId: "32524.dat", position: [0, 0.005, 0],       quaternion: [0, 0, 0, 1], colorCode: 4, zone: ZoneType.ACTIVE_ARENA },
    "32523.dat": { ldrawId: "32523.dat", position: [0.03, 0.005, 0.04], quaternion: [0, 0, 0, 1], colorCode: 1, zone: ZoneType.ACTIVE_ARENA },
    "6558.dat":  { ldrawId: "6558.dat",  position: [-0.03, 0.03, 0],    quaternion: [0, 0, 0, 1], colorCode: 0, zone: ZoneType.ACTIVE_ARENA },
  },
  connections: {},
  wsConnected: false,
  selectedPort: null,
  interactionPhase: InteractionPhase.IDLE,
  focusedPartId: null,
  focusMode: null,
  showPortGizmos: true,
  enableFocusAnimation: true,
  enableSSAO: false,
  enableContactShadows: false,
  debugMode: false,
  previewPartId: null,
  canUndo: false,
  canRedo: false,
  stagingGrid: new StagingGrid(),

  setView: (view) => set({ view }),

  toggleMode: async () => {
    const currentMode = get().mode;
    const nextMode = currentMode === 'ASSEMBLY' ? 'SIMULATION' : 'ASSEMBLY';
    try {
      await axios.post(`${API_URL}/toggle_mode?mode=${nextMode}`);
      set({ mode: nextMode, selectedPort: null, interactionPhase: InteractionPhase.IDLE });
    } catch (e) {
      console.error("Failed to toggle mode:", e);
    }
  },

  updatePartState: (partId, state) => set((prev) => {
    const prevPart = prev.parts[partId];
    if (!prevPart) return {};
    return {
      parts: {
        ...prev.parts,
        [partId]: { ...prevPart, ...state } as PartState,
      }
    };
  }),

  batchUpdatePartStates: (updates) => set((prev) => ({
    parts: { ...prev.parts, ...updates }
  })),

  setWsConnected: (status) => set({ wsConnected: status }),
  setFocus: ({ partId, mode }) => set({ focusedPartId: partId, focusMode: mode }),
  setShowPortGizmos: (value) => set({ showPortGizmos: value }),
  setEnableFocusAnimation: (value) => set({ enableFocusAnimation: value }),
  setEnableSSAO: (value) => set({ enableSSAO: value }),
  setEnableContactShadows: (value) => set({ enableContactShadows: value }),
  setDebugMode: (value) => set({ debugMode: value }),

  setPartZone: (partId, zone) => set((prev) => {
    const part = prev.parts[partId];
    if (!part) return {};
    return { parts: { ...prev.parts, [partId]: { ...part, zone } } };
  }),

  undo: () => {
    _history.undo();
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
  },

  redo: () => {
    _history.redo();
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
  },

  // =================================================================
  // handlePortClick — FSM 驱动的端口点击入口
  // =================================================================
  handlePortClick: async (port: SelectedPortInfo) => {
    const { interactionPhase, selectedPort, snapParts } = get();

    if (interactionPhase === InteractionPhase.IDLE) {
      // 第一次点击 → 锁定 Source
      if (!isValidTransition(interactionPhase, InteractionPhase.SOURCE_LOCKED)) return;
      set({ selectedPort: port, interactionPhase: InteractionPhase.SOURCE_LOCKED });
      return;
    }

    // 仅当用户在预览模式下（PREVIEWING）点击预览层的端口时才触发预览锁定。
    if (interactionPhase === InteractionPhase.PREVIEWING) {
      // 在预览窗口中点击了某个端口 -> 锁定为 Source，等待场内 Target
      if (!isValidTransition(interactionPhase, InteractionPhase.SOURCE_LOCKED)) return;
      set({
        selectedPort: port,
        interactionPhase: InteractionPhase.SOURCE_LOCKED,
        previewPartId: null // 选定端口后自动关闭预览窗口
      });
      return;
    }

    if (interactionPhase === InteractionPhase.SOURCE_LOCKED) {
      if (!selectedPort) {
        // 状态异常修复
        set({ interactionPhase: InteractionPhase.IDLE, selectedPort: null });
        return;
      }
      if (port.partId === selectedPort.partId) {
        // 点击同一零件 → 取消
        set({ interactionPhase: InteractionPhase.IDLE, selectedPort: null });
        return;
      }
      // 第二次点击 → 触发 Snap
      set({ interactionPhase: InteractionPhase.ANIMATING_SNAP });
      const ok = await snapParts(selectedPort, port);
      set({
        interactionPhase: InteractionPhase.IDLE,
        selectedPort: null,
        canUndo: _history.canUndo,
        canRedo: _history.canRedo,
      });
      if (!ok) console.warn('[handlePortClick] snapParts returned false');
      return;
    }

    // ANIMATING_SNAP — 忽略输入
  },

  // =================================================================
  // snapParts — "先选即动"：Source 永远移动到 Target
  // =================================================================

  snapParts: async (source: SelectedPortInfo, target: SelectedPortInfo) => {
    const parts = get().parts;
    const connections = get().connections;

    const targetPart = parts[target.partId];
    if (!targetPart) return false;

    // 获取 Source 零件状态：若不存在，则实例化新零件
    let sourcePart = parts[source.partId];
    if (!sourcePart) {
      sourcePart = {
        ldrawId: source.ldrawId,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        colorCode: 7, // 默认点云灰
        zone: ZoneType.ACTIVE_ARENA,
      };
    }

    // 仅允许在 ACTIVE_ARENA 零件之间进行 Snap (对新进入零件默认放行)
    if (targetPart.zone !== ZoneType.ACTIVE_ARENA) {
      console.warn('[snapParts] 拒绝: Target 非 ACTIVE_ARENA 零件');
      return false;
    }

    const baseAxis: Vec3 = [0, 0, 1]; // Z 轴约定
    const srcAxisLocal = mat3MulVec3(source.rotation, baseAxis);
    const tgtAxisLocal = mat3MulVec3(target.rotation, baseAxis);
    const srcAxisWorld = vecNormalize(quatApplyToVec3(sourcePart.quaternion, srcAxisLocal));
    const tgtAxisWorld = vecNormalize(quatApplyToVec3(targetPart.quaternion, tgtAxisLocal));

    const isPegIntoHole = source.portType === 'peg' && target.portType === 'peghole';

    const srcGroup = getConnectedGroup(connections, source.partId, target.partId);

    // 保存 Snap 前快照
    const prevPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
    for (const pid of srcGroup) {
      const p = parts[pid];
      if (p) prevPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
    }

    const updated: Record<string, PartState> = { ...parts };

    // 如果 Source 组是新选中的馆藏零件（场内还没有），在此初始化其初始位姿
    if (!parts[source.partId]) {
      updated[source.partId] = sourcePart;
    }

    // 步骤 1：旋转 Source 组
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
        ...part,
        position: vecAdd(pivot, relRot),
        quaternion: quatNormalize(quatMultiply(qDelta, part.quaternion)),
      };
    }

    // 步骤 2：对齐
    const targetWorldPos = vecAdd(
      targetPart.position,
      quatApplyToVec3(targetPart.quaternion, target.position),
    );

    const rotatedSource = updated[source.partId]!;
    const sourceWorldPos = vecAdd(
      rotatedSource.position,
      quatApplyToVec3(rotatedSource.quaternion, source.position),
    );

    const moveDelta = vecSub(targetWorldPos, sourceWorldPos);

    for (const pid of srcGroup) {
      const part = updated[pid];
      if (!part) continue;
      updated[pid] = {
        ...part,
        position: vecAdd(part.position, moveDelta),
      };
    }

    // 步骤 3：区域切换与槽位释放
    for (const pid of srcGroup) {
      const part = updated[pid];
      if (!part) continue;
      updated[pid] = { ...part, zone: ZoneType.ACTIVE_ARENA };
      get().stagingGrid.releaseSlot(pid);
    }

    // 连接图
    const newConnections = { ...connections };
    if (!newConnections[source.partId]) newConnections[source.partId] = new Set();
    if (!newConnections[target.partId]) newConnections[target.partId] = new Set();
    newConnections[source.partId] = new Set(newConnections[source.partId]).add(target.partId);
    newConnections[target.partId] = new Set(newConnections[target.partId]).add(source.partId);

    // History
    const snapSnapshot: SnapSnapshot = { 
      movedPartIds: srcGroup, 
      prevPositions, 
      addedConnections: [{ from: source.partId, to: target.partId }] 
    };

    const snapCmd = createSnapCommand(
      snapSnapshot,
      () => {},
      (snap: SnapSnapshot) => {
        set((prev: any) => {
          const revertedParts = { ...prev.parts };
          for (const [pid, saved] of Object.entries(snap.prevPositions)) {
            if (revertedParts[pid]) revertedParts[pid] = { ...revertedParts[pid], ...saved };
          }
          const revertedConn = { ...prev.connections };
          for (const { from, to } of snap.addedConnections) {
            const f = new Set(revertedConn[from]); f.delete(to);
            const t = new Set(revertedConn[to]); t.delete(from);
            revertedConn[from] = f; revertedConn[to] = t;
          }
          return { parts: revertedParts, connections: revertedConn };
        });
      },
    );
    _history.push(snapCmd);

    set({ parts: updated, connections: newConnections, selectedPort: null });

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
    } catch (e) {}

    return true;
  },

  previewPart: (partId: string) => {
    const { interactionPhase } = get();
    const nextPhase = InteractionEvents.previewPart(interactionPhase);
    set({ previewPartId: partId, interactionPhase: nextPhase, selectedPort: null });
  },

  stagePart: (partId: string) => {
    const pid = String(partId).trim();
    const { parts, connections, stagingGrid } = get();
    const part = parts[pid];
    if (!part) return;

    if (part.zone !== ZoneType.ACTIVE_ARENA) return;

    const slot = stagingGrid.assign(pid);
    if (!slot) {
      console.warn("Staging tray is full! Clear some space first.");
      return;
    }

    const nextConnections: Record<string, Set<string>> = {};
    for (const key in connections) {
      if (key === pid) continue;
      const neighborSet = connections[key];
      if (neighborSet.has(pid)) {
        const newSet = new Set(neighborSet);
        newSet.delete(pid);
        if (newSet.size > 0) nextConnections[key] = newSet;
      } else {
        nextConnections[key] = neighborSet;
      }
    }

    const updated: Record<string, PartState> = { ...parts };
    updated[pid] = {
      ...part,
      position: slot.worldPosition,
      quaternion: [0, 0, 0, 1],
      zone: ZoneType.STAGED,
    };

    set({ parts: updated, connections: nextConnections });
  }
}));

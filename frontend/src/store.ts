import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import axios from 'axios';
import { 
  InteractionPhase, 
  SelectionLevel, 
  SelectionAnchor, 
  InterferenceReport,
  PartState,
  Vec3,
  Quat,
  Mat3,
  SelectedPortInfo,
  ZoneType,
  FreePlacingProjectionMode
} from './types';
import { isValidTransition } from './interactionFSM';
import { StagingGrid } from './staging';
import { HistoryStack, createSnapCommand, TopologySnapshot, createTopologyCommand } from './historyStack';
import { calculateSnapPose, calculatePortRotationPose } from './utils/snapMath';
import { getDefaultColorCode } from './utils/partColorDefaults';

type ConnectionGraph = Record<string, Set<string>>;

const API_URL = 'http://localhost:8000';

interface StoreLog {
    timestamp: number;
    type: 'INFO' | 'ACTION' | 'ERROR' | 'PHYSICS';
    message: string;
}

interface StoreState {
  mode: 'ASSEMBLY' | 'SIMULATION';
  view: 'ASSEMBLY' | 'LIBRARY_VERIFY';
  parts: Record<string, PartState>;
  connections: ConnectionGraph;
  wsConnected: boolean;
  selectedPort: SelectedPortInfo | null;
  hoveredPort: SelectedPortInfo | null;
  slidingTarget: SelectedPortInfo | null; // 正在滑动的目标参考点
  interactionPhase: InteractionPhase;
  focusedPartId: string | null;
  focusMode: 'part' | 'assembly' | null;
  showPortGizmos: boolean;
  enableFocusAnimation: boolean;
  enableSSAO: boolean;
  enableContactShadows: boolean;
  debugMode: boolean;
  debugShowPorts: boolean;
  previewPartId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  stagingGrid: StagingGrid;
  snapPreState: {
    movedPartIds: string[];
    prevPositions: Record<string, { position: Vec3; quaternion: Quat }>;
    addedConnections: Array<{ from: string; to: string }>;
    addedPartIds?: string[];
  } | null;
  continuousPlacementSource: SelectedPortInfo | null; // 用于记录正在连续放置（复制）的源端口信息

  /**
   * 全局活跃颜色码 (LDraw Color Code)。
   * 从颜色选择器写入，在创建零件实例时作为 colorCode 默认值注入。
   * 默认值 4 (Red) 仅作为示例；实际工程中应由用户在 UI 中显式选取。
   */
  activeColorCode: number;
  
  // 日志系统
  logs: StoreLog[];
  showLogPanel: boolean;
  isContextLost: boolean;

  // v1.2 State
  selection: {
    primaryId: string | null;
    level: SelectionLevel;
    allConnectedIds: string[];
    excludedIds: string[];
  };
  clipboard: { id: string; state: PartState }[];
  freePlacingPayload: { id: string; state: PartState }[];
  freePlacingPointer: { clientX: number; clientY: number } | null;
  freePlacingProjectionMode: FreePlacingProjectionMode;
  hiddenParts: Set<string>;
  interferenceReport: InterferenceReport;
  slideOffset: number;
  cameraTarget: [number, number, number] | null;
  partUsages: Record<string, number>;

  // Actions
  reset: () => void;
  setView: (view: 'ASSEMBLY' | 'LIBRARY_VERIFY') => void;
  toggleMode: () => Promise<void>;
  updatePartState: (partId: string, state: Partial<PartState>) => void;
  batchUpdatePartStates: (updates: Record<string, Partial<PartState>>) => void;
  setWsConnected: (status: boolean) => void;
  setFocus: (focus: { partId: string | null; mode: 'part' | 'assembly' | null }) => void;
  setCameraTarget: (target: [number, number, number] | null) => void;
  setShowPortGizmos: (value: boolean) => void;
  setEnableFocusAnimation: (value: boolean) => void;
  setEnableSSAO: (value: boolean) => void;
  setEnableContactShadows: (value: boolean) => void;
  setDebugMode: (value: boolean) => void;
  setDebugShowPorts: (value: boolean) => void;
  setPartZone: (partId: string, zone: ZoneType) => void;

  /** 全局颜色选择：更新 activeColorCode，后续所有零件实例使用此颜色 */
  setActiveColorCode: (code: number) => void;
  
  undo: () => void;
  redo: () => void;

  handlePortClick: (port: SelectedPortInfo) => Promise<void>;
  setHoveredPort: (port: SelectedPortInfo | null) => void;
  snapParts: (source: SelectedPortInfo, target: SelectedPortInfo, slideOffset?: number) => Promise<boolean>;
  abortCurrentInteraction: () => void;
  
  // 日志 Actions
  addLog: (msg: string, type?: StoreLog['type']) => void;
  clearLogs: () => void;
  toggleLogPanel: (show?: boolean) => void;
  setContextLost: (lost: boolean) => void;

  // v1.2 Actions
  deleteSelected: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  duplicateSelected: () => void;
  setHiddenSelected: (hide: boolean) => void;
  showAll: () => void;
  selectAll: () => void;
  deselectAll: () => void;
  setMarqueeSelection: (ids: string[]) => void;

  addParts: (ids: string[]) => void;
  removeParts: (ids: string[]) => void;
  connectParts: (a: string, pa: string, b: string, pb: string) => void;
  selectPart: (id: string | null, level?: SelectionLevel, append?: boolean) => void;
  updateSelection: (level: SelectionLevel) => void;
  updateSlideOffset: (offset: number) => void;
  rotateSelectedPart: (angleRads: number) => void;
  setBlocked: (report: InterferenceReport) => void;
  setPhase: (phase: InteractionPhase) => void;
  previewPart: (id: string | null) => void;
  stagePart: (id: string) => void;
  commitAxialSliding: () => void;
  focusCameraOnSelected: () => void;
  startFreePlacing: (
    ldrawId: string,
    colorCode: number,
    options?: {
      pointer?: { clientX: number; clientY: number } | null;
      projectionMode?: FreePlacingProjectionMode;
    }
  ) => void;
  commitFreePlacing: (finalStates?: Record<string, PartState>) => void;
}

const quatNormalize = (q: [number, number, number, number]): Quat => {
  const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]) || 1;
  return [q[0]/len, q[1]/len, q[2]/len, q[3]/len];
};

const getQuatFromMat3 = (m: Mat3): Quat => {
  const mm = m as number[][];
  const nm: number[][] = [];
  for (let col = 0; col < 3; col++) {
    const v = [mm[0][col], mm[1][col], mm[2][col]];
    const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
    nm.push([v[0]/len, v[1]/len, v[2]/len]);
  }
  
  const m11 = nm[0][0], m12 = nm[1][0], m13 = nm[2][0];
  const m21 = nm[0][1], m22 = nm[1][1], m23 = nm[2][1];
  const m31 = nm[0][2], m32 = nm[1][2], m33 = nm[2][2];

  const tr = m11 + m22 + m33;
  let q: [number, number, number, number] = [0, 0, 0, 1];

  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1.0);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  return quatNormalize(q);
};

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

const _history = new HistoryStack(50);

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
  mode: 'ASSEMBLY',
  view: 'ASSEMBLY',
  parts: {},
  connections: {},
  wsConnected: false,
  selectedPort: null,
  hoveredPort: null,
  slidingTarget: null,
  interactionPhase: InteractionPhase.IDLE,
  focusedPartId: null,
  focusMode: null,
  showPortGizmos: true,
  enableFocusAnimation: true,
  enableSSAO: true,
  enableContactShadows: true,
  debugMode: false,
  debugShowPorts: false,
  previewPartId: null,
  canUndo: false,
  canRedo: false,
  stagingGrid: new StagingGrid(),
  snapPreState: null,
  continuousPlacementSource: null,

  // 全局活跃颜色码，默认为 4 (Red)，供新建零件实例时使用
  activeColorCode: 4,
  
  logs: [],
  showLogPanel: false,
  isContextLost: false,

  selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
  clipboard: [],
  freePlacingPayload: [],
  freePlacingPointer: null,
  freePlacingProjectionMode: FreePlacingProjectionMode.SCENE_RAYCAST,
  hiddenParts: new Set(),
  interferenceReport: { isBlocked: false, blockingPartId: null, contactPoints: [], reason: null },
  slideOffset: 0,
  cameraTarget: null,
  partUsages: {},

  reset: () => {
      get().addLog("Store reset to default state.");
      get().stagingGrid.clearAll();
      set({
        parts: {},
        connections: {},
        interactionPhase: InteractionPhase.IDLE,
        selectedPort: null,
        hoveredPort: null,
        selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
        clipboard: [],
        freePlacingPayload: [],
        freePlacingPointer: null,
        freePlacingProjectionMode: FreePlacingProjectionMode.SCENE_RAYCAST,
        hiddenParts: new Set(),
        interferenceReport: { isBlocked: false, blockingPartId: null, contactPoints: [], reason: null },
        slideOffset: 0,
        cameraTarget: null,
        snapPreState: null,
        continuousPlacementSource: null,
        isContextLost: false
      });
  },

  setView: (view) => {
      get().addLog(`Switching view to: ${view}`);
      set({ view });
  },

  toggleMode: async () => {
    const nextMode = get().mode === 'ASSEMBLY' ? 'SIMULATION' : 'ASSEMBLY';
    get().addLog(`Toggling mode to: ${nextMode}`, 'ACTION');
    try {
      // 路由与后端 FastAPI 定义保持一致：/api/toggle_mode
      await axios.post(`${API_URL}/api/toggle_mode?mode=${nextMode}`);
      set({ mode: nextMode, selectedPort: null, interactionPhase: InteractionPhase.IDLE, continuousPlacementSource: null });
    } catch (e) {
      get().addLog(`Failed to toggle mode: ${e}`, 'ERROR');
    }
  },

  updatePartState: (partId, state) => set((prev) => {
    const part = prev.parts[partId];
    if (!part) return {};
    return { parts: { ...prev.parts, [partId]: { ...part, ...state } } };
  }),

  batchUpdatePartStates: (updates) => set((prev) => {
      const newParts = { ...prev.parts };
      Object.entries(updates).forEach(([id, state]) => {
          if (newParts[id]) newParts[id] = { ...newParts[id], ...state };
      });
      return { parts: newParts };
  }),

  setWsConnected: (status) => {
      if (status !== get().wsConnected) {
          get().addLog(`WebSocket ${status ? 'Connected' : 'Disconnected'}`, status ? 'INFO' : 'ERROR');
      }
      set({ wsConnected: status });
  },
  
  setCameraTarget: (target) => set({ cameraTarget: target }),

  setFocus: ({ partId, mode }) => {
      const msg = partId ? `Focusing on ${partId} (Mode: ${mode})` : "Clearing focus";
      get().addLog(msg);
      set({ focusedPartId: partId, focusMode: mode });
      
      if (partId && get().enableFocusAnimation) {
          const state = get().parts[partId];
          if (state) {
              set({ cameraTarget: [state.position[0], state.position[1], state.position[2]] });
          }
      } else if (!partId) {
          set({ cameraTarget: null });
      }
  },
  
  setShowPortGizmos: (value) => set({ showPortGizmos: value }),
  setEnableFocusAnimation: (value) => set({ enableFocusAnimation: value }),
  setEnableSSAO: (value) => set({ enableSSAO: value }),
  setEnableContactShadows: (value) => set({ enableContactShadows: value }),
  setDebugMode: (value) => {
      get().addLog(`Debug mode: ${value}`);
      set({ debugMode: value });
  },
  setDebugShowPorts: (value) => set({ debugShowPorts: value }),
  setPartZone: (partId, zone) => get().updatePartState(partId, { zone }),

  setActiveColorCode: (code) => {
      get().addLog(`Active color code changed to: ${code}`, 'ACTION');
      set({ activeColorCode: code });
  },

  undo: () => {
    _history.undo();
    get().addLog("Undo performed", 'ACTION');
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
  },

  redo: () => {
    _history.redo();
    get().addLog("Redo performed", 'ACTION');
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
  },

  handlePortClick: async (port: SelectedPortInfo) => {
    const { interactionPhase, snapParts, parts } = get();
    get().addLog(`Port clicked: ${port.partId} (${port.ldrawId})`, 'ACTION');

    // 如果当前正在滑动，任意点击都应先静默提交滑动状态
    // 注意：连续放置模式下 commitAxialSliding 会用新 instanceId 覆盖 selectedPort，
    // 因此 selectedPort 必须在 commit 之后再读取，不能提前解构。
    if (interactionPhase === InteractionPhase.AXIAL_SLIDING) {
      get().commitAxialSliding();
    }
    const selectedPort = get().selectedPort;

    const activeParts = Object.values(parts).filter(p => p.zone === ZoneType.ACTIVE_ARENA);
    if (activeParts.length === 0 && (interactionPhase === InteractionPhase.IDLE || interactionPhase === InteractionPhase.PREVIEWING)) {
      get().addLog(`Starting first part in scene: ${port.partId}`);
      const instanceId = port.partId;
      // 颜色决策：字典预设色 > 画笔色（activeColorCode）
      const initialColorCode = getDefaultColorCode(
        port.ldrawId || port.partId,
        get().activeColorCode
      );
      set((state) => ({
        parts: {
          ...state.parts,
          [instanceId]: {
            ldrawId: port.ldrawId || instanceId.split('_')[0],
            position: [0, 0, 0] as Vec3,
            quaternion: [0, 0, 0, 1] as Quat,
            colorCode: initialColorCode,
            zone: ZoneType.ACTIVE_ARENA
          }
        },
        interactionPhase: InteractionPhase.IDLE,
        previewPartId: null,
        selectedPort: null
      }));
      return;
    }

    // 现在 interactionPhase 可能是 IDLE (如果刚才由于提交而转为 IDLE)
    const currentPhase = get().interactionPhase;
    if (currentPhase === InteractionPhase.IDLE || currentPhase === InteractionPhase.PREVIEWING) {
      get().addLog(`Source port locked: ${port.partId}`);
      set({ 
        selectedPort: port, 
        interactionPhase: InteractionPhase.SOURCE_LOCKED, 
        previewPartId: null,
        continuousPlacementSource: port.isFromPreview ? port : null // 开启连续放置模式
      });
      return;
    }
    if (currentPhase === InteractionPhase.SOURCE_LOCKED && selectedPort) {
      if (port.partId === selectedPort.partId) {
        get().addLog("Clicked another port on same part, switching source.");
        set({ selectedPort: port }); // 切换源端口，不中止
        return;
      }
      get().addLog(`Target port selected: ${port.partId}. Starting snap animation...`, 'PHYSICS');
      
      const { connections, parts } = get();
      const srcGroup = getConnectedGroup(connections, selectedPort.partId, port.partId);
      const prevPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
      const addedPartIds: string[] = [];
      srcGroup.forEach(pid => {
        const p = parts[pid];
        if (p) prevPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
        else addedPartIds.push(pid);
      });

      set({ 
        interactionPhase: InteractionPhase.ANIMATING_SNAP,
        snapPreState: {
          movedPartIds: srcGroup,
          prevPositions,
          addedConnections: [{ from: selectedPort.partId, to: port.partId }],
          addedPartIds
        }
      });

      const ok = await snapParts(selectedPort, port);
      
      if (ok) {
          get().addLog("Snap SUCCESSFUL. Entering Axial Sliding...", 'PHYSICS');
          set({ 
            interactionPhase: InteractionPhase.AXIAL_SLIDING,
            slidingTarget: port,
            slideOffset: 0
          });
      } else {
          get().addLog("Snap FAILED.", 'ERROR');
          set({ interactionPhase: InteractionPhase.IDLE, selectedPort: null, hoveredPort: null });
      }
    }
  },

  setHoveredPort: (port) => {
    const { interactionPhase, continuousPlacementSource } = get();
    if (interactionPhase === InteractionPhase.SOURCE_LOCKED || 
       (interactionPhase === InteractionPhase.AXIAL_SLIDING && continuousPlacementSource)) {
      set({ hoveredPort: port });
    } else {
      if (get().hoveredPort !== null) set({ hoveredPort: null });
    }
  },

  snapParts: async (source, target, slideOffset = 0) => {
    const { parts, connections, stagingGrid } = get();
    const targetPart = parts[target.partId];
    if (!targetPart || targetPart.zone !== ZoneType.ACTIVE_ARENA) return false;

    const srcGroup = getConnectedGroup(connections, source.partId, target.partId);
    let sourcePart = parts[source.partId] || {
      ldrawId: source.ldrawId, position: [0, 0, 0] as Vec3, quaternion: [0, 0, 0, 1] as Quat, colorCode: getDefaultColorCode(source.ldrawId || source.partId, get().activeColorCode), zone: ZoneType.ACTIVE_ARENA
    };

    const prevPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
    srcGroup.forEach(pid => {
      const p = parts[pid];
      if (p) prevPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
    });

    const { position, quaternion } = calculateSnapPose(
      source.position as Vec3,
      getQuatFromMat3(source.rotation as Mat3),
      target.globalPos as Vec3,
      (target.globalQuat || [0, 0, 0, 1]) as Quat, // 增加安全回退
      slideOffset
    );

    const updated: Record<string, PartState> = { ...parts };
    updated[source.partId] = {
      ...sourcePart,
      position: position as Vec3,
      quaternion: quaternion as Quat,
      zone: ZoneType.ACTIVE_ARENA
    };

    stagingGrid.releaseSlot(source.partId);

    const newConnections = { ...connections };
    [source.partId, target.partId].forEach(id => { if (!newConnections[id]) newConnections[id] = new Set(); });
    newConnections[source.partId].add(target.partId);
    newConnections[target.partId].add(source.partId);

    // History recording is now handled in commitAxialSliding to allow for proper undo/redo of the sliding action

    // 先更新本地状态，保证 UI 立即响应（乐观更新）
    set({ parts: updated, connections: newConnections });

    // ── v3.1：异步通知后端登记拓扑并触发 Auto-Latch ──────────────────────────
    // 降级策略：后端调用失败不影响前端已完成的本地连接（与 server.py 中 AutoLatch
    // 异常处理策略保持对称）。
    // parent 为目标零件（静止基准），child 为被吸附的源零件（刚发生位移）。
    const snapPayload = {
      parent_id: target.partId,
      child_id:  source.partId,
      port_type_p: target.portType,
      port_type_c: source.portType,
      parent_origin: target.globalPos,
      parent_rot:    (target.rotation as number[]).flat ? (target.rotation as number[][]).flat() : target.rotation,
      child_origin:  position,        // Snap 后的最终 SI 世界坐标
      child_rot:     (source.rotation as number[]).flat ? (source.rotation as number[][]).flat() : source.rotation,
      // v3.1 字段：世界坐标，用于 AutoLatchScanner 的 Site 距离筛选
      parent_world_pos: target.globalPos,
      child_world_pos:  position,
    };

    axios.post(`${API_URL}/api/snap_parts`, snapPayload).then((res) => {
      const { auto_latched_count } = res.data as { auto_latched_count?: number };
      if (auto_latched_count && auto_latched_count > 0) {
        get().addLog(
          `[AutoLatch] Snap(${source.partId} ↔ ${target.partId}): 后端自动闭合 ${auto_latched_count} 条额外连接。`,
          'INFO'
        );
      }
    }).catch((err) => {
      // 降级：后端拓扑注册失败，仅记录警告，不撤销前端已建立的本地连接
      get().addLog(
        `[AutoLatch] 后端 snap_parts 调用失败（本地连接已建立）: ${err instanceof Error ? err.message : String(err)}`,
        'ERROR'
      );
    });

    return true;
  },

  abortCurrentInteraction: () => {
    const pre = get().snapPreState;
    if (pre) {
        set(prev => {
            const rp = { ...prev.parts };
            if (pre.addedPartIds) {
                pre.addedPartIds.forEach(id => delete rp[id]);
            }
            Object.entries(pre.prevPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
            const rc = { ...prev.connections };
            pre.addedConnections.forEach(({ from, to }) => {
                if (rc[from]) {
                    const nextSet = new Set(rc[from]);
                    nextSet.delete(to);
                    if (nextSet.size === 0) delete rc[from]; else rc[from] = nextSet;
                }
                if (rc[to]) {
                    const nextSet = new Set(rc[to]);
                    nextSet.delete(from);
                    if (nextSet.size === 0) delete rc[to]; else rc[to] = nextSet;
                }
            });
            return { parts: rp, connections: rc };
        });
    }

    get().addLog("Aborting port interaction.");
    set({ 
      interactionPhase: InteractionPhase.IDLE, 
      selectedPort: null, 
      hoveredPort: null,
      slidingTarget: null,
      slideOffset: 0,
      snapPreState: null,
      continuousPlacementSource: null
    });
  },

  addLog: (message, type = 'INFO') => set(s => ({
      logs: [...s.logs, { timestamp: Date.now(), type, message }].slice(-200) // 保持最近200条
  })),

  clearLogs: () => set({ logs: [] }),
  toggleLogPanel: (show) => set(s => ({ showLogPanel: show !== undefined ? show : !s.showLogPanel })),
  
  setContextLost: (lost: boolean) => {
      get().addLog(`WebGL Context ${lost ? 'Lost' : 'Restored'}`, lost ? 'ERROR' : 'INFO');
      set({ isContextLost: lost });
  },

  deleteSelected: () => {
    const { parts, connections, selection } = get();
    const idsToDelete = selection.allConnectedIds;
    if (idsToDelete.length === 0) return;

    const removedParts: Record<string, PartState> = {};
    const removedConns: Array<{ from: string; to: string }> = [];
    
    idsToDelete.forEach(id => {
      if (parts[id]) {
        removedParts[id] = parts[id];
        if (connections[id]) {
          connections[id].forEach(target => {
            if (!removedConns.find(c => (c.from === target && c.to === id) || (c.from === id && c.to === target))) {
              removedConns.push({ from: id, to: target });
            }
          });
        }
      }
    });

    const snap: TopologySnapshot = { addedParts: {}, removedParts, addedConnections: [], removedConnections: removedConns };
    
    const doRemove = (ids: string[]) => {
      set(s => {
        const np = { ...s.parts };
        const nc = { ...s.connections };
        ids.forEach(id => {
          delete np[id];
          delete nc[id];
          Object.keys(nc).forEach(target => {
            if (nc[target].has(id)) {
              const nextSet = new Set(nc[target]);
              nextSet.delete(id);
              nc[target] = nextSet;
            }
          });
        });
        return { parts: np, connections: nc };
      });
    };

    const doAdd = (pa: Record<string, PartState>, conns: Array<{from: string; to: string}>) => {
      set(s => {
        const np = { ...s.parts, ...pa };
        const nc = { ...s.connections };
        conns.forEach(c => {
          nc[c.from] = nc[c.from] ? new Set(nc[c.from]) : new Set();
          nc[c.to] = nc[c.to] ? new Set(nc[c.to]) : new Set();
          nc[c.from].add(c.to);
          nc[c.to].add(c.from);
        });
        return { parts: np, connections: nc };
      });
    };

    const cmd = createTopologyCommand('DELETE', snap, 
      () => doRemove(idsToDelete),
      (s) => doAdd(s.removedParts, s.removedConnections)
    );

    doRemove(idsToDelete);
    set({ selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] } });
    _history.push(cmd);
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
    get().addLog(`Deleted ${idsToDelete.length} parts.`, 'ACTION');
  },

  copySelected: () => {
    const { parts, selection } = get();
    const idsToCopy = selection.allConnectedIds;
    if (idsToCopy.length === 0) return;
    
    const clipData = idsToCopy.map(id => ({ id, state: JSON.parse(JSON.stringify(parts[id])) }));
    set({ clipboard: clipData });
    get().addLog(`Copied ${idsToCopy.length} parts.`, 'ACTION');
  },

  pasteClipboard: () => {
    const { clipboard } = get();
    if (!clipboard || clipboard.length === 0) return;

    // 计算剪贴板包围盒中心，使得复制出的“幽灵”始终位于鼠标正中央
    let cx = 0, cy = 0, cz = 0;
    clipboard.forEach(clip => {
      cx += clip.state.position[0];
      cy += clip.state.position[1];
      cz += clip.state.position[2];
    });
    cx /= clipboard.length;
    cy /= clipboard.length;
    cz /= clipboard.length;

    const payload = clipboard.map(clip => {
      const newId = clip.id.split('_')[0] + '_' + window.crypto.randomUUID().substring(0,8);
      const st = JSON.parse(JSON.stringify(clip.state));
      st.position = [st.position[0] - cx, st.position[1] - cy, st.position[2] - cz];
      st.zone = ZoneType.ACTIVE_ARENA;
      return { id: newId, state: st as PartState };
    });

    set({ 
      freePlacingPayload: payload,
      interactionPhase: InteractionPhase.FREE_PLACING 
    });
    get().addLog(`Started placing ${payload.length} parts from clipboard.`, 'ACTION');
  },

  startFreePlacing: (ldrawId: string, colorCode: number, options = {}) => {
    const {
      pointer = null,
      projectionMode = FreePlacingProjectionMode.SCENE_RAYCAST
    } = options;
    const newId = ldrawId.split('.')[0] + '_' + window.crypto.randomUUID().substring(0,8);
    const payload = [{
      id: newId,
      state: {
        ldrawId,
        position: [0, 0, 0] as Vec3,
        quaternion: [0, 0, 0, 1] as Quat,
        colorCode,
        zone: ZoneType.ACTIVE_ARENA
      }
    }];
    set({
      freePlacingPayload: payload,
      freePlacingPointer: pointer,
      freePlacingProjectionMode: projectionMode,
      interactionPhase: InteractionPhase.FREE_PLACING,
      previewPartId: null // 关掉预览层
    });
    get().addLog(`Started free placing for new part ${ldrawId}.`, 'ACTION');
  },

  commitFreePlacing: (finalStates?: Record<string, PartState>) => {
    const { freePlacingPayload } = get();
    if (!freePlacingPayload || freePlacingPayload.length === 0) return;

    if (!finalStates) {
      // Aborted or cancelled
      set({
        freePlacingPayload: [],
        freePlacingPointer: null,
        freePlacingProjectionMode: FreePlacingProjectionMode.SCENE_RAYCAST,
        interactionPhase: InteractionPhase.IDLE
      });
      return;
    }

    const addedParts: Record<string, PartState> = {};
    const newIds: string[] = [];
    Object.entries(finalStates).forEach(([id, state]) => {
      addedParts[id] = state;
      newIds.push(id);
    });

    const snap: TopologySnapshot = { addedParts, removedParts: {}, addedConnections: [], removedConnections: [] };
    
    const doAdd = (pa: Record<string, PartState>) => {
      set(s => ({ parts: { ...s.parts, ...pa } }));
    };
    const doRemove = (ids: string[]) => {
      set(s => {
        const np = { ...s.parts };
        ids.forEach(id => delete np[id]);
        return { parts: np };
      });
    };

    const cmd = createTopologyCommand('PASTE', snap, 
      () => doAdd(addedParts),
      () => doRemove(newIds)
    );

    doAdd(addedParts);
    _history.push(cmd);
    set({ 
      canUndo: _history.canUndo, 
      canRedo: _history.canRedo,
      selection: { primaryId: newIds[0], level: SelectionLevel.GROUP, allConnectedIds: newIds, excludedIds: [] },
      freePlacingPayload: [],
      freePlacingPointer: null,
      freePlacingProjectionMode: FreePlacingProjectionMode.SCENE_RAYCAST,
      interactionPhase: InteractionPhase.IDLE
    });
    get().addLog(`Committed ${newIds.length} parts.`, 'ACTION');
  },

  duplicateSelected: () => {
    get().copySelected();
    get().pasteClipboard();
  },

  setHiddenSelected: (hide: boolean) => {
    const { selection, hiddenParts } = get();
    const ids = selection.allConnectedIds;
    if (ids.length === 0) return;
    
    const newHidden = new Set(hiddenParts);
    ids.forEach(id => {
      if (hide) newHidden.add(id);
      else newHidden.delete(id);
    });
    set({ hiddenParts: newHidden });
    get().addLog(`${hide ? 'Hidden' : 'Showed'} ${ids.length} parts.`, 'ACTION');
  },

  showAll: () => {
    set({ hiddenParts: new Set() });
    get().addLog(`Showed all parts.`, 'ACTION');
  },

  selectAll: () => {
    const { parts, hiddenParts } = get();
    const activeIds = Object.keys(parts).filter(k => parts[k].zone === ZoneType.ACTIVE_ARENA && !hiddenParts.has(k));
    set({ 
      selection: { 
        primaryId: activeIds.length > 0 ? activeIds[0] : null, 
        level: SelectionLevel.GROUP, 
        allConnectedIds: activeIds, 
        excludedIds: [] 
      }
    });
    get().addLog(`Selected all ${activeIds.length} visible parts.`, 'ACTION');
  },

  deselectAll: () => {
    set({ selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] } });
  },

  setMarqueeSelection: (ids: string[]) => {
    if (ids.length === 0) {
      set({ selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] } });
    } else {
      set({ 
        selection: { 
          primaryId: ids[0], 
          level: SelectionLevel.GROUP, 
          allConnectedIds: ids, 
          excludedIds: [] 
        } 
      });
      get().addLog(`Marquee selected ${ids.length} parts.`, 'ACTION');
    }
  },

  focusCameraOnSelected: () => {
    const { parts, selection } = get();
    const ids = selection.allConnectedIds;
    if (ids.length === 0) return;
    
    let cx = 0, cy = 0, cz = 0;
    let count = 0;
    ids.forEach(id => {
      const p = parts[id];
      if (p) {
        cx += p.position[0];
        cy += p.position[1];
        cz += p.position[2];
        count++;
      }
    });
    if (count > 0) {
      set({ cameraTarget: [cx / count, cy / count, cz / count] });
      get().addLog(`Focused camera on ${count} selected parts.`, 'ACTION');
    }
  },

  addParts: (ids) => set(s => {
    get().addLog(`Add parts to scene: ${ids.join(', ')}`, 'ACTION');
    const np = { ...s.parts };
    const fallback = get().activeColorCode;
    ids.forEach(id => {
      // 颜色决策：字典预设色 > 画笔色（activeColorCode）
      const ldrawId = id.split('_')[0] + '.dat';
      const colorCode = getDefaultColorCode(ldrawId, fallback);
      np[id] = { ldrawId, position: [0,0,0], quaternion: [0,0,0,1], colorCode, zone: ZoneType.ACTIVE_ARENA };
    });
    return { parts: np };
  }),
  removeParts: (ids) => set(s => {
    get().addLog(`Removing parts: ${ids.join(', ')}`, 'ACTION');
    const np = { ...s.parts };
    ids.forEach(id => delete np[id]);
    return { parts: np };
  }),
  connectParts: (a_id, pa, b_id, pb) => set(s => {
    get().addLog(`Establishing connection: ${a_id} <-> ${b_id}`);
    const nc = { ...s.connections };
    if (!nc[a_id]) nc[a_id] = new Set();
    if (!nc[b_id]) nc[b_id] = new Set();
    nc[a_id].add(b_id); nc[b_id].add(a_id);
    return { connections: nc };
  }),
  selectPart: (id, level = SelectionLevel.GROUP, append = false) => {
      get().addLog(`Selecting part: ${id} (Level: ${level}, append: ${append})`, 'ACTION');
      
      const prevSelection = get().selection;
      let targetLevel = level;

      let newIds: string[] = [];
      if (id && targetLevel === SelectionLevel.GROUP) {
          newIds = getConnectedGroup(get().connections, id, "");
      } else if (id) {
          newIds = [id];
      }

      let allConnectedIds: string[] = [];
      if (append && id) {
          const currentSet = new Set(prevSelection.allConnectedIds);
          // Toggle mechanics: if all new ones are already in, remove them. Otherwise add them.
          const isAllSelected = newIds.every(n => currentSet.has(n));
          if (isAllSelected) {
              newIds.forEach(n => currentSet.delete(n));
          } else {
              newIds.forEach(n => currentSet.add(n));
          }
          allConnectedIds = Array.from(currentSet);
      } else {
          allConnectedIds = newIds;
      }

      set({ 
          selection: { 
              ...prevSelection, 
              primaryId: append ? (allConnectedIds.length > 0 ? allConnectedIds[allConnectedIds.length - 1] : null) : id, 
              level: targetLevel,
              allConnectedIds
          } 
      });
  },
  updateSelection: (level) => set({ selection: { ...get().selection, level } }),
  updateSlideOffset: (o) => {
    const { selectedPort, slidingTarget, snapParts } = get();
    if (selectedPort && slidingTarget) {
      set({ slideOffset: o });
      snapParts(selectedPort, slidingTarget, o); // 实时更新位置
    }
  },
  
  rotateSelectedPart: (angleRads: number) => {
    const { parts, selectedPort, updatePartState } = get();
    if (!selectedPort) return;
    
    // The part being rotated is the one that contains the selectedPort.
    const partId = selectedPort.partId;
    const part = parts[partId];
    if (!part) return;

    // Use our utility to calculate new world pose rotated along local Z
    const newPose = calculatePortRotationPose(
        part.position,
        part.quaternion,
        selectedPort.position,
        getQuatFromMat3(selectedPort.rotation),
        angleRads
    );

    // Update the store and sync to physics
    updatePartState(partId, newPose);
    get().addLog(`Rotated part ${partId} by ${angleRads.toFixed(2)} rads`);
  },

  commitAxialSliding: () => {
    const { snapPreState, parts } = get();
    if (snapPreState) {
        const nextPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
        snapPreState.movedPartIds.forEach(pid => {
            const p = parts[pid];
            if (p) nextPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
        });

        const cmd = createSnapCommand(
            snapPreState,
            () => { // redo
                set(prev => {
                    const rp = { ...prev.parts };
                    Object.entries(nextPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
                    const rc = { ...prev.connections };
                    snapPreState.addedConnections.forEach(({ from, to }) => {
                        if (!rc[from]) rc[from] = new Set();
                        if (!rc[to]) rc[to] = new Set();
                        rc[from].add(to);
                        rc[to].add(from);
                    });
                    return { parts: rp, connections: rc };
                });
            },
            (snap) => { // undo
                set(prev => {
                    const rp = { ...prev.parts };
                    if (snap.addedPartIds) {
                        snap.addedPartIds.forEach(id => delete rp[id]);
                    }
                    Object.entries(snap.prevPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
                    const rc = { ...prev.connections };
                    snap.addedConnections.forEach(({ from, to }) => {
                        if (rc[from]) {
                            const nextSet = new Set(rc[from]);
                            nextSet.delete(to);
                            if (nextSet.size === 0) delete rc[from]; else rc[from] = nextSet;
                        }
                        if (rc[to]) {
                            const nextSet = new Set(rc[to]);
                            nextSet.delete(from);
                            if (nextSet.size === 0) delete rc[to]; else rc[to] = nextSet;
                        }
                    });
                    return { parts: rp, connections: rc };
                });
            }
        );
        _history.push(cmd);
    }

    const cp = get().continuousPlacementSource;
    if (cp) {
      // 连续放置模式：生成新的 instanceId 保持对齐状态
      const newInstanceId = `${cp.ldrawId}_${window.crypto.randomUUID().substring(0,8)}`;
      const newSelectedPort = { ...cp, partId: newInstanceId };
      set({
        interactionPhase: InteractionPhase.SOURCE_LOCKED,
        selectedPort: newSelectedPort,
        hoveredPort: null,
        slidingTarget: null,
        slideOffset: 0,
        snapPreState: null,
        canUndo: _history.canUndo,
        canRedo: _history.canRedo
      });
      get().addLog("Axial Sliding committed. Ready for next continuous placement.", 'ACTION');
    } else {
      set({ 
        interactionPhase: InteractionPhase.IDLE, 
        selectedPort: null, 
        hoveredPort: null, 
        slidingTarget: null,
        slideOffset: 0,
        snapPreState: null,
        canUndo: _history.canUndo,
        canRedo: _history.canRedo 
      });
      get().addLog("Axial Sliding committed.", 'ACTION');
    }
  },
  setBlocked: (r) => set({ interferenceReport: r }),
  setPhase: (p) => set({ interactionPhase: p }),
  commitAction: () => set({ interactionPhase: InteractionPhase.IDLE }),
  previewPart: (id: string | null) => {
    if (id) {
        get().addLog(`[DEBUG] Previewing part ${id}, incrementing usage count.`, 'ACTION');
        set(state => ({
            partUsages: {
                ...state.partUsages,
                [id]: (state.partUsages[id] || 0) + 1
            }
        }));
    }
    set({ 
      previewPartId: id,
      interactionPhase: id ? InteractionPhase.PREVIEWING : InteractionPhase.IDLE,
      continuousPlacementSource: null // 清除连续放置状态
    });
  },
  stagePart: (id) => {
    const p = get().parts[id];
    if (p) {
        // 记录操作前的状态，以便撤销
        const prevPartState = JSON.parse(JSON.stringify(p)) as PartState;
        const prevConnections = get().connections[id] ? Array.from(get().connections[id]) : [];
        const removedConns: Array<{ from: string; to: string }> = [];
        prevConnections.forEach(target => {
            removedConns.push({ from: id, to: target });
        });

        get().addLog(`Staging part: ${id}`);
        const slot = get().stagingGrid.assign(id);
        if (!slot) {
            get().addLog(`Staging tray FULL. Cannot stage ${id}`, 'ERROR');
            return;
        }

        const newPos = slot.worldPosition;
        
        const executeStage = () => {
            const currentSlot = get().stagingGrid.assign(id);
            if (currentSlot) {
                get().updatePartState(id, { 
                    zone: ZoneType.STAGED,
                    position: currentSlot.worldPosition as Vec3,
                    quaternion: [0, 0, 0, 1] as Quat
                });
            }
            set(state => {
                const newConns = { ...state.connections };
                delete newConns[id];
                Object.keys(newConns).forEach(targetId => {
                    if (newConns[targetId].has(id)) {
                        const nextSet = new Set(newConns[targetId]);
                        nextSet.delete(id);
                        newConns[targetId] = nextSet;
                    }
                });
                return { connections: newConns };
            });
        };

        const undoStage = () => {
            get().stagingGrid.releaseSlot(id);
            get().updatePartState(id, prevPartState);
            set(state => {
                const newConns = { ...state.connections };
                removedConns.forEach(c => {
                    if (!newConns[c.from]) newConns[c.from] = new Set();
                    if (!newConns[c.to]) newConns[c.to] = new Set();
                    newConns[c.from].add(c.to);
                    newConns[c.to].add(c.from);
                });
                return { connections: newConns };
            });
        };

        // 立即执行并入栈
        get().updatePartState(id, { 
            zone: ZoneType.STAGED,
            position: newPos as Vec3,
            quaternion: [0, 0, 0, 1] as Quat // 重置为水平
        });

        set(state => {
            const newConns = { ...state.connections };
            // 清除自己的
            delete newConns[id];
            // 从邻居中删除自己
            Object.keys(newConns).forEach(targetId => {
                if (newConns[targetId].has(id)) {
                    const nextSet = new Set(newConns[targetId]);
                    nextSet.delete(id);
                    newConns[targetId] = nextSet;
                }
            });
            return { connections: newConns };
        });

        const snap: TopologySnapshot = {
            addedParts: {},
            removedParts: {},
            addedConnections: [],
            removedConnections: removedConns
        };
        const cmd = createTopologyCommand('STAGE', snap, executeStage, undoStage);
        _history.push(cmd);
        set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
    }
  }
}), {
  name: 'lego-cad-assembly-storage',
  partialize: (state) => ({
    parts: state.parts,
    connections: Object.fromEntries(
      Object.entries(state.connections).map(([k, v]) => [k, Array.from(v)])
    ) as unknown as ConnectionGraph, // 暂存为 array，因为 Set 无法序列化
    activeColorCode: state.activeColorCode,
    cameraTarget: state.cameraTarget,
    partUsages: state.partUsages,
    hiddenParts: Array.from(state.hiddenParts) as unknown as Set<string>,
  }),
  // Rehydrate 时需要把 connections 里的 Array 转回 Set
  merge: (persistedState: unknown, currentState: StoreState) => {
    const pState = persistedState as Partial<StoreState> & { connections?: Record<string, string[]>, hiddenParts?: string[] };
    const mergedConnections: ConnectionGraph = {};
    if (pState.connections) {
      Object.entries(pState.connections).forEach(([k, arr]) => {
        mergedConnections[k] = new Set(arr as string[]);
      });
    }
    return {
      ...currentState,
      ...pState,
      connections: mergedConnections,
      hiddenParts: pState.hiddenParts ? new Set(pState.hiddenParts) : new Set(),
    };
  },
  onRehydrateStorage: () => (state) => {
    if (state) {
      state.stagingGrid.clearAll();
      Object.entries(state.parts).forEach(([id, p]) => {
        if (p.zone === ZoneType.STAGED) {
          state.stagingGrid.assign(id);
        }
      });
      state.addLog('State rehydrated from local storage.');
    }
  }
}));

// 为 E2E 测试环境暴露入口
if (typeof window !== 'undefined') {
  // @ts-ignore
  window.__STORE__ = useStore;
}

// ---------------------------------------------------------------------------
// 派生状态 Selectors (SRP 抽象)
// ---------------------------------------------------------------------------
export const useIsTargetSeekingPhase = () => useStore(s => s.interactionPhase === InteractionPhase.SOURCE_LOCKED);

import { create } from 'zustand';
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
  ZoneType
} from './types';
import { isValidTransition } from './interactionFSM';
import { StagingGrid } from './staging';
import { HistoryStack, createSnapCommand } from './historyStack';
import { calculateSnapPose } from './utils/snapMath';

type ConnectionGraph = Record<string, Set<string>>;

const API_URL = 'http://localhost:8000';

interface StoreState {
  mode: 'ASSEMBLY' | 'SIMULATION';
  view: 'ASSEMBLY' | 'LIBRARY_VERIFY';
  parts: Record<string, PartState>;
  connections: ConnectionGraph;
  wsConnected: boolean;
  selectedPort: SelectedPortInfo | null;
  hoveredPort: SelectedPortInfo | null;
  interactionPhase: InteractionPhase;
  focusedPartId: string | null;
  focusMode: 'part' | 'assembly' | null;
  showPortGizmos: boolean;
  enableFocusAnimation: boolean;
  enableSSAO: boolean;
  enableContactShadows: boolean;
  debugMode: boolean;
  previewPartId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  stagingGrid: StagingGrid;

  // v1.2 State
  selection: {
    primaryId: string | null;
    level: SelectionLevel;
    allConnectedIds: string[];
    excludedIds: string[];
  };
  interferenceReport: InterferenceReport;
  slideOffset: number;

  // Actions
  reset: () => void;
  setView: (view: 'ASSEMBLY' | 'LIBRARY_VERIFY') => void;
  toggleMode: () => Promise<void>;
  updatePartState: (partId: string, state: Partial<PartState>) => void;
  batchUpdatePartStates: (updates: Record<string, Partial<PartState>>) => void;
  setWsConnected: (status: boolean) => void;
  setFocus: (focus: { partId: string | null; mode: 'part' | 'assembly' | null }) => void;
  setShowPortGizmos: (value: boolean) => void;
  setEnableFocusAnimation: (value: boolean) => void;
  setEnableSSAO: (value: boolean) => void;
  setEnableContactShadows: (value: boolean) => void;
  setDebugMode: (value: boolean) => void;
  setPartZone: (partId: string, zone: ZoneType) => void;
  
  undo: () => void;
  redo: () => void;

  handlePortClick: (port: SelectedPortInfo) => Promise<void>;
  setHoveredPort: (port: SelectedPortInfo | null) => void;
  snapParts: (source: SelectedPortInfo, target: SelectedPortInfo) => Promise<boolean>;
  abortCurrentInteraction: () => void;

  // v1.2 Actions
  addParts: (ids: string[]) => void;
  removeParts: (ids: string[]) => void;
  connectParts: (a: string, pa: string, b: string, pb: string) => void;
  selectPart: (id: string | null, level?: SelectionLevel) => void;
  updateSelection: (level: SelectionLevel) => void;
  updateSlideOffset: (offset: number) => void;
  setBlocked: (report: InterferenceReport) => void;
  setPhase: (phase: InteractionPhase) => void;
  commitAction: () => void;
  previewPart: (id: string | null) => void;
  stagePart: (id: string) => void;
}

const quatNormalize = (q: [number, number, number, number]): Quat => {
  const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]) || 1;
  return [q[0]/len, q[1]/len, q[2]/len, q[3]/len];
};

const getQuatFromMat3 = (m: Mat3): Quat => {
  const mm = m as number[][];
  
  // 1. Column Normalization (Robustness against float / LDraw scaling)
  const nm: number[][] = [];
  for (let col = 0; col < 3; col++) {
    const v = [mm[0][col], mm[1][col], mm[2][col]];
    const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
    nm.push([v[0]/len, v[1]/len, v[2]/len]);
  }
  
  // mm is already Row-Major if coming from Python's tolist()
  // But our nm is now technically [col0, col1, col2]
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

export const useStore = create<StoreState>((set, get) => ({
  mode: 'ASSEMBLY',
  view: 'ASSEMBLY',
  parts: {},
  connections: {},
  wsConnected: false,
  selectedPort: null,
  hoveredPort: null,
  interactionPhase: InteractionPhase.IDLE,
  focusedPartId: null,
  focusMode: null,
  showPortGizmos: true,
  enableFocusAnimation: true,
  enableSSAO: true,
  enableContactShadows: true,
  debugMode: false,
  previewPartId: null,
  canUndo: false,
  canRedo: false,
  stagingGrid: new StagingGrid(),

  selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
  interferenceReport: { isBlocked: false, blockingPartId: null, contactPoints: [], reason: null },
  slideOffset: 0,

  reset: () => set({
    interactionPhase: InteractionPhase.IDLE,
    selectedPort: null,
    hoveredPort: null,
    selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
    interferenceReport: { isBlocked: false, blockingPartId: null, contactPoints: [], reason: null },
    slideOffset: 0
  }),

  setView: (view) => set({ view }),

  toggleMode: async () => {
    const nextMode = get().mode === 'ASSEMBLY' ? 'SIMULATION' : 'ASSEMBLY';
    try {
      await axios.post(`${API_URL}/toggle_mode?mode=${nextMode}`);
      set({ mode: nextMode, selectedPort: null, interactionPhase: InteractionPhase.IDLE });
    } catch (e) {
      console.error("Failed to toggle mode:", e);
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

  setWsConnected: (status) => set({ wsConnected: status }),
  setFocus: ({ partId, mode }) => set({ focusedPartId: partId, focusMode: mode }),
  setShowPortGizmos: (value) => set({ showPortGizmos: value }),
  setEnableFocusAnimation: (value) => set({ enableFocusAnimation: value }),
  setEnableSSAO: (value) => set({ enableSSAO: value }),
  setEnableContactShadows: (value) => set({ enableContactShadows: value }),
  setDebugMode: (value) => set({ debugMode: value }),
  setPartZone: (partId, zone) => get().updatePartState(partId, { zone }),

  undo: () => {
    _history.undo();
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
  },

  redo: () => {
    _history.redo();
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
  },

  handlePortClick: async (port: SelectedPortInfo) => {
    const { interactionPhase, selectedPort, snapParts, parts } = get();
    
    const activeParts = Object.values(parts).filter(p => p.zone === ZoneType.ACTIVE_ARENA);
    if (activeParts.length === 0 && (interactionPhase === InteractionPhase.IDLE || interactionPhase === InteractionPhase.PREVIEWING)) {
      const instanceId = port.partId;
      set((state) => ({
        parts: {
          ...state.parts,
          [instanceId]: {
            ldrawId: port.ldrawId || instanceId.split('_')[0],
            position: [0, 0, 0] as Vec3,
            quaternion: [0, 0, 0, 1] as Quat,
            colorCode: 7, 
            zone: ZoneType.ACTIVE_ARENA
          }
        },
        interactionPhase: InteractionPhase.IDLE,
        previewPartId: null,
        selectedPort: null
      }));
      return;
    }

    if (interactionPhase === InteractionPhase.IDLE || interactionPhase === InteractionPhase.PREVIEWING) {
      set({ selectedPort: port, interactionPhase: InteractionPhase.SOURCE_LOCKED, previewPartId: null });
      return;
    }
    if (interactionPhase === InteractionPhase.SOURCE_LOCKED && selectedPort) {
      if (port.partId === selectedPort.partId) {
        get().abortCurrentInteraction();
        return;
      }
      set({ interactionPhase: InteractionPhase.ANIMATING_SNAP });
      const ok = await snapParts(selectedPort, port);
      set({ interactionPhase: InteractionPhase.IDLE, selectedPort: null, hoveredPort: null, canUndo: _history.canUndo, canRedo: _history.canRedo });
      if (!ok) console.warn('Snap failed');
    }
  },

  setHoveredPort: (port) => {
    const { interactionPhase } = get();
    if (interactionPhase === InteractionPhase.SOURCE_LOCKED) {
      set({ hoveredPort: port });
    } else {
      if (get().hoveredPort !== null) set({ hoveredPort: null });
    }
  },

  snapParts: async (source, target) => {
    const { parts, connections, stagingGrid } = get();
    const targetPart = parts[target.partId];
    if (!targetPart || targetPart.zone !== ZoneType.ACTIVE_ARENA) return false;

    const srcGroup = getConnectedGroup(connections, source.partId, target.partId);
    let sourcePart = parts[source.partId] || {
      ldrawId: source.ldrawId, position: [0, 0, 0] as Vec3, quaternion: [0, 0, 0, 1] as Quat, colorCode: 7, zone: ZoneType.ACTIVE_ARENA
    };

    const prevPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
    srcGroup.forEach(pid => {
      const p = parts[pid];
      if (p) prevPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
    });

    const { position, quaternion } = calculateSnapPose(
      source.position as Vec3, 
      getQuatFromMat3(source.rotation),
      target.position as Vec3,
      getQuatFromMat3(target.rotation)
    );

    const updated: Record<string, PartState> = { ...parts };
    updated[source.partId] = {
      ...sourcePart,
      position: position as any,
      quaternion: quaternion as any,
      zone: ZoneType.ACTIVE_ARENA
    };

    stagingGrid.releaseSlot(source.partId);

    const newConnections = { ...connections };
    [source.partId, target.partId].forEach(id => { if (!newConnections[id]) newConnections[id] = new Set(); });
    newConnections[source.partId].add(target.partId);
    newConnections[target.partId].add(source.partId);

    const cmd = createSnapCommand({ movedPartIds: srcGroup, prevPositions, addedConnections: [{ from: source.partId, to: target.partId }] }, () => {}, (snap) => {
        set(prev => {
            const rp = { ...prev.parts };
            Object.entries(snap.prevPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...s as any }; });
            return { parts: rp };
        });
    });
    _history.push(cmd);
    set({ parts: updated, connections: newConnections });
    return true;
  },

  abortCurrentInteraction: () => {
    set({ interactionPhase: InteractionPhase.IDLE, selectedPort: null, hoveredPort: null });
  },

  addParts: (ids) => set(s => {
    const np = { ...s.parts };
    ids.forEach(id => { np[id] = { ldrawId: id.split('_')[0] + '.dat', position: [0,0,0], quaternion: [0,0,0,1], colorCode: 16, zone: ZoneType.ACTIVE_ARENA }; });
    return { parts: np };
  }),
  removeParts: (ids) => set(s => {
    const np = { ...s.parts };
    ids.forEach(id => delete np[id]);
    return { parts: np };
  }),
  connectParts: (a_id, pa, b_id, pb) => set(s => {
    const nc = { ...s.connections };
    if (!nc[a_id]) nc[a_id] = new Set();
    if (!nc[b_id]) nc[b_id] = new Set();
    nc[a_id].add(b_id); nc[b_id].add(a_id);
    return { connections: nc };
  }),
  selectPart: (id, level = SelectionLevel.GROUP) => set({ selection: { ...get().selection, primaryId: id, level } }),
  updateSelection: (level) => set({ selection: { ...get().selection, level } }),
  updateSlideOffset: (o) => set({ slideOffset: o }),
  setBlocked: (r) => set({ interferenceReport: r }),
  setPhase: (p) => set({ interactionPhase: p }),
  commitAction: () => set({ interactionPhase: InteractionPhase.IDLE }),
  previewPart: (id) => set({ previewPartId: id }),
  stagePart: (id) => {
    const p = get().parts[id];
    if (p) {
        get().updatePartState(id, { zone: ZoneType.STAGED });
        get().stagingGrid.assign(id);
    }
  }
}));

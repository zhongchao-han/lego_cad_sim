import { create } from 'zustand';
import axios from 'axios';

const API_URL = 'http://127.0.0.1:8000/api';

interface PartState {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

// 连接图：记录哪些零件已互相连接（邻接表）
type ConnectionGraph = Record<string, Set<string>>;

type FocusMode = 'part' | 'port' | null;

interface StoreState {
  mode: 'ASSEMBLY' | 'SIMULATION';
  parts: Record<string, PartState>;
  connections: ConnectionGraph; // 零件连接图
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
  position: [number, number, number]; // 端口在零件本地坐标系中的坐标
  rotation: number[][];
  globalPos: [number, number, number]; // 端口在世界坐标系中的位置
}

/**
 * BFS 查找与 startId 相连的所有零件（连通分量）
 * 但排除 excludeId，以避免把 target 侧的零件也拉过来
 */
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
    // 放入初始测试用的两个方块件及一根轴
    "base_link": { position: [0, 0.005, 0], quaternion: [0, 0, 0, 1] },
    "beam_1x5": { position: [0.06, 0.005, 0], quaternion: [0, 0, 0, 1] },
    "friction_pin": { position: [0.03, 0.03, 0], quaternion: [0, 0, 0, 1] },
  },
  connections: {}, // 初始无连接
  wsConnected: false,
  selectedPort: null,
  // 是否在前端启用基于 LDraw 语义的渲染/端口数据
  useLDraw: false,
  // 相机聚焦状态
  focusedPartId: null,
  focusMode: null,
  // 调试与可视化开关
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

  setFocus: ({ partId, mode }) => set({
    focusedPartId: partId,
    focusMode: mode,
  }),

  setShowPortGizmos: (value) => set({ showPortGizmos: value }),

  setEnableFocusAnimation: (value) => set({ enableFocusAnimation: value }),

  snapParts: async (source, target) => {
    const parts = get().parts;
    const connections = get().connections;

    // 1. 找到 source 所属的整个连通组（不穿越 target 侧）
    const group = getConnectedGroup(connections, source.partId, target.partId);

    // 2. 计算 source 端口世界坐标与 target 端口世界坐标的偏移
    const dx = target.globalPos[0] - source.globalPos[0];
    const dy = target.globalPos[1] - source.globalPos[1];
    const dz = target.globalPos[2] - source.globalPos[2];

    // 3. 把整个连通组中所有零件都平移相同的 delta
    const updatedParts = { ...parts };
    for (const partId of group) {
      const part = updatedParts[partId];
      if (part) {
        updatedParts[partId] = {
          ...part,
          position: [
            part.position[0] + dx,
            part.position[1] + dy,
            part.position[2] + dz,
          ] as [number, number, number],
        };
      }
    }

    // 4. 更新连接图：source ↔ target 建立双向连接
    const newConnections = { ...connections };
    if (!newConnections[source.partId]) newConnections[source.partId] = new Set();
    if (!newConnections[target.partId]) newConnections[target.partId] = new Set();
    newConnections[source.partId] = new Set(newConnections[source.partId]).add(target.partId);
    newConnections[target.partId] = new Set(newConnections[target.partId]).add(source.partId);

    // 5. 立即更新前端状态
    set({
      parts: updatedParts,
      connections: newConnections,
      selectedPort: null,
    });

    console.log(`✅ 已吸附: [${group.join(', ')}] → ${target.partId}，位移 [${dx.toFixed(4)}, ${dy.toFixed(4)}, ${dz.toFixed(4)}]`);

    // 6. 同时通知后端建立拓扑边
    try {
      await axios.post(`${API_URL}/snap_parts`, {
        parent_id: target.partId,
        child_id: source.partId,
        port_type_p: target.portType,
        port_type_c: source.portType,
        parent_origin: target.position,
        parent_rot: target.rotation.flat(),
        child_origin: source.position,
        child_rot: source.rotation.flat(),
      });
      return true;
    } catch (e) {
      console.error("Snapping failed:", e);
      return false;
    }
  }
}));

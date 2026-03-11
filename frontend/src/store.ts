import { create } from 'zustand';
import axios from 'axios';

const API_URL = 'http://127.0.0.1:8000/api';

interface PartState {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

interface StoreState {
  mode: 'ASSEMBLY' | 'SIMULATION';
  parts: Record<string, PartState>;
  wsConnected: boolean;
  selectedPort: SelectedPortInfo | null;
  toggleMode: () => Promise<void>;
  updatePartState: (partId: string, state: PartState) => void;
  setWsConnected: (status: boolean) => void;
  setSelectedPort: (port: SelectedPortInfo | null) => void;
  snapParts: (source: SelectedPortInfo, target: SelectedPortInfo) => Promise<boolean>;
}

export interface SelectedPortInfo {
  partId: string;
  portType: string;
  position: [number, number, number]; // 端口在零件本地坐标系中的坐标
  rotation: number[][];
  globalPos: [number, number, number]; // 端口在世界坐标系中的位置
}

export const useStore = create<StoreState>((set, get) => ({
  mode: 'ASSEMBLY',
  parts: {
    // 放入初始测试用的两个方块件及一根轴
    "base_link": { position: [0, 0.005, 0], quaternion: [0, 0, 0, 1] },
    "beam_1x5": { position: [0.06, 0.005, 0], quaternion: [0, 0, 0, 1] },
    "friction_pin": { position: [0.03, 0.03, 0], quaternion: [0, 0, 0, 1] },
  },
  wsConnected: false,
  selectedPort: null,

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

  snapParts: async (source, target) => {
    // 即时视觉吸附：把 source 零件移动到使其端口对齐 target 端口的位置
    const parts = get().parts;
    const sourcePart = parts[source.partId];

    if (sourcePart) {
      // 计算 source 端口的世界坐标与 target 端口世界坐标之间的偏移
      // delta = target.globalPos - source.globalPos
      // 新位置 = sourcePart.position + delta
      const dx = target.globalPos[0] - source.globalPos[0];
      const dy = target.globalPos[1] - source.globalPos[1];
      const dz = target.globalPos[2] - source.globalPos[2];

      const newPos: [number, number, number] = [
        sourcePart.position[0] + dx,
        sourcePart.position[1] + dy,
        sourcePart.position[2] + dz,
      ];

      // 立即更新前端位置
      set((prev) => ({
        parts: {
          ...prev.parts,
          [source.partId]: {
            ...prev.parts[source.partId],
            position: newPos,
          },
        },
        selectedPort: null,
      }));

      console.log(`✅ 已吸附: ${source.partId} → ${target.partId}，位移 [${dx.toFixed(4)}, ${dy.toFixed(4)}, ${dz.toFixed(4)}]`);
    }

    // 同时通知后端建立拓扑边
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

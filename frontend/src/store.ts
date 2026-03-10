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
  position: [number, number, number];
  rotation: number[][];
  globalPos: [number, number, number]; // 用于吸附展示辅助线的位置
}

export const useStore = create<StoreState>((set, get) => ({
  mode: 'ASSEMBLY',
  parts: {
    // 放入初始测试用的两个方块件及一根轴
    "base_link": { position: [0, 0, 0.5], quaternion: [0, 0, 0, 1] },
    "beam_1x5": { position: [0.05, 0, 0.5], quaternion: [0, 0, 0, 1] },
    "friction_pin": { position: [0.025, 0.05, 0.5], quaternion: [0, 0, 0, 1] },
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
    try {
      await axios.post(`${API_URL}/snap_parts`, {
        parent_id: target.partId,
        child_id: source.partId,
        port_type_p: target.portType,
        port_type_c: source.portType,
        parent_origin: target.position,
        parent_rot: target.rotation.flat(), // Flat to 9-element array
        child_origin: source.position,
        child_rot: source.rotation.flat(),
      });
      // 成功吸附后解除选中
      set({ selectedPort: null });
      return true;
    } catch (e) {
      console.error("Snapping failed:", e);
      return false;
    }
  }
}));

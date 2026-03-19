import { create } from 'zustand';

export interface PortData {
  type: string;
  position: [number, number, number];
  rotation: number[][];
}

export interface PendingPart {
  part_id: string;
  confidence: number;
  port_count: number;
}

interface VerificationState {
  pendingList: PendingPart[];
  currentPartId: string | null;
  currentPorts: PortData[];
  isLoading: boolean;
  
  // Actions
  fetchPendingList: () => Promise<void>;
  selectPart: (partId: string) => Promise<void>;
  addPort: (type: 'peghole' | 'peg') => void;
  deletePort: (index: number) => void;
  updatePort: (index: number, newData: Partial<PortData>) => void;
  movePort: (index: number, axis: 0 | 1 | 2, delta: number) => void;
  flipPortZ: (index: number) => void;
  rotatePort90: (index: number) => void;
  rotateX90: (index: number) => void;
  rotateY90: (index: number) => void;
  rotateZ90: (index: number) => void;
  snapPortToGrid: (index: number) => void;
  saveVerification: () => Promise<void>;
}

const API_BASE = 'http://127.0.0.1:8000/api';

export const useVerificationStore = create<VerificationState>((set, get) => ({
  pendingList: [],
  currentPartId: null,
  currentPorts: [],
  isLoading: false,

  fetchPendingList: async () => {
    set({ isLoading: true });
    try {
      const resp = await fetch(`${API_BASE}/verify/pending_list`);
      const data = await resp.json();
      set({ pendingList: data });
    } finally {
      set({ isLoading: false });
    }
  },

  selectPart: async (partId: string) => {
    set({ isLoading: true, currentPartId: partId });
    try {
      const resp = await fetch(`${API_BASE}/ldraw_part/${partId}`);
      const data = await resp.json();
      set({ currentPorts: data.ports });
    } finally {
      set({ isLoading: false });
    }
  },

  addPort: (type) => {
    const newPort: PortData = {
      type: type === 'peghole' ? 'peghole.dat' : 'peg',
      position: [0, 0, 0],
      rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    };
    set({ currentPorts: [...get().currentPorts, newPort] });
  },

  deletePort: (index) => {
    const newPorts = get().currentPorts.filter((_, i) => i !== index);
    set({ currentPorts: newPorts });
  },

  updatePort: (index, newData) => {
    const newPorts = [...get().currentPorts];
    const target = { ...newPorts[index], ...newData };
    
    // 递归进行智能吸附与数据清洗
    const clean = (v: any): any => {
      if (typeof v === 'number') {
        const snapped = Math.round(v / 10) * 10;
        // 如果误差在 0.1 LDU 以内，强制吸附回 10L 格点 (乐高标准半孔距精度)
        if (Math.abs(v - snapped) < 0.1) return snapped;
        return Math.round(v * 10000) / 10000;
      }
      if (Array.isArray(v)) return v.map(clean);
      return v;
    };

    if (target.position) target.position = clean(target.position);
    if (target.rotation) target.rotation = clean(target.rotation);

    newPorts[index] = target;
    set({ currentPorts: newPorts });
  },

  movePort: (index, axis, delta) => {
    const port = get().currentPorts[index];
    const newPos = [...port.position] as [number, number, number];
    const rawVal = newPos[axis] + delta;
    // 使用高精度舍入（4位）消除 IEEE 754 噪音，同时保留可能的微小偏置
    newPos[axis] = Math.round(rawVal * 10000) / 10000;
    get().updatePort(index, { position: newPos });
  },

  flipPortZ: (index) => {
    const port = get().currentPorts[index];
    const rot = port.rotation;
    const newRot = [
      [rot[0][0], -rot[0][1], -rot[0][2]],
      [rot[1][0], -rot[1][1], -rot[1][2]],
      [rot[2][0], -rot[2][1], -rot[2][2]]
    ];
    get().updatePort(index, { rotation: newRot });
  },

  rotatePort90: (index) => get().rotateX90(index), // 默认旋转 X 轴（更直观）

  rotateX90: (index) => {
    const port = get().currentPorts[index];
    const rot = port.rotation;
    const newRot = [
      [rot[0][0], rot[0][2], -rot[0][1]],
      [rot[1][0], rot[1][2], -rot[1][1]],
      [rot[2][0], rot[2][2], -rot[2][1]]
    ];
    get().updatePort(index, { rotation: newRot });
  },

  rotateY90: (index) => {
    const port = get().currentPorts[index];
    const rot = port.rotation;
    const newRot = [
      [-rot[0][2], rot[0][1], rot[0][0]],
      [-rot[1][2], rot[1][1], rot[1][0]],
      [-rot[2][2], rot[2][1], rot[2][0]]
    ];
    get().updatePort(index, { rotation: newRot });
  },

  rotateZ90: (index) => {
    const port = get().currentPorts[index];
    const rot = port.rotation;
    const newRot = [
      [rot[0][1], -rot[0][0], rot[0][2]],
      [rot[1][1], -rot[1][0], rot[1][2]],
      [rot[2][1], -rot[2][0], rot[2][2]]
    ];
    get().updatePort(index, { rotation: newRot });
  },

  snapPortToGrid: (index) => {
    const port = get().currentPorts[index];
    const snap = (v: number) => Math.round(v / 10) * 10;
    const newPos: [number, number, number] = [
      snap(port.position[0]),
      snap(port.position[1]),
      snap(port.position[2])
    ];
    get().updatePort(index, { position: newPos });
  },

  saveVerification: async () => {
    const { currentPartId, currentPorts } = get();
    if (!currentPartId) return;

    set({ isLoading: true });
    try {
      const resp = await fetch(`${API_BASE}/verify/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          part_id: currentPartId,
          ports: currentPorts
        })
      });
      if (resp.ok) {
        await get().fetchPendingList();
        set({ currentPartId: null, currentPorts: [] });
      }
    } finally {
      set({ isLoading: false });
    }
  }
}));

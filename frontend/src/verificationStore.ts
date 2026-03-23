import { create } from 'zustand';
import { useStore } from './store';
import { clearPartCache } from './useLDrawPart';

export interface PortData {
  name: string;
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
  searchList: PendingPart[];
  currentPartId: string | null;
  currentPorts: PortData[];
  isLoading: boolean;
  
  // Actions
  fetchPendingList: () => Promise<void>;
  searchParts: (query: string) => Promise<void>;
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

// 内部日志工具辅助函数
const log = (msg: string, type: 'INFO' | 'ACTION' | 'PHYSICS' | 'ERROR' = 'INFO') => {
    useStore.getState().addLog(`[Workbench] ${msg}`, type);
};

export const useVerificationStore = create<VerificationState>((set, get) => ({
  pendingList: [],
  searchList: [],
  currentPartId: null,
  currentPorts: [],
  isLoading: false,

  fetchPendingList: async () => {
    set({ isLoading: true });
    try {
      const resp = await fetch(`${API_BASE}/verify/pending_list`);
      const data = await resp.json();
      set({ pendingList: data });
    } catch (e) {
      log(`Failed to fetch pending list: ${e}`, 'ERROR');
    } finally {
      set({ isLoading: false });
    }
  },

  searchParts: async (query: string) => {
    if (!query) {
      set({ searchList: [] });
      return;
    }
    set({ isLoading: true });
    try {
      const resp = await fetch(`${API_BASE}/verify/search?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      set({ searchList: data });
    } catch (e) {
       log(`Search failed for "${query}": ${e}`, 'ERROR');
    } finally {
      set({ isLoading: false });
    }
  },

  selectPart: async (partId: string) => {
    log(`Examining part: ${partId}`, 'ACTION');
    set({ isLoading: true, currentPartId: partId });
    try {
      const resp = await fetch(`${API_BASE}/ldraw_part/${encodeURIComponent(partId)}?include_pending=true`);
      const data = await resp.json();
      
      const LDU = 0.0004;
      const ports = data?.ports || [];
      const normalizedPorts = ports.map((p: any) => ({
        ...p,
        position: (p.position || [0, 0, 0]).map((v: number) => v / LDU)
      }));
      
      set({ currentPorts: normalizedPorts });
      log(`Loaded ${normalizedPorts.length} ports for ${partId}`);
    } catch (e) {
      log(`Failed to load part ${partId}: ${e}`, 'ERROR');
    } finally {
      set({ isLoading: false });
    }
  },

  addPort: (type) => {
    log(`Manually adding port: ${type}`, 'ACTION');
    const newPort: PortData = {
      name: `manual_${Date.now()}`, // [补丁] 确保前端手动生成的端口具备唯一 Name 以满足后端 Pydantic 校验
      type: type === 'peghole' ? 'peghole.dat' : 'peg',
      position: [0, 0, 0],
      rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    };
    set({ currentPorts: [...get().currentPorts, newPort] });
  },

  deletePort: (index) => {
    log(`Deleting port index [${index}]`, 'ACTION');
    const newPorts = [...get().currentPorts];
    newPorts.splice(index, 1);
    set({ currentPorts: newPorts });
  },

  updatePort: (index, newData) => {
    const newPorts = [...get().currentPorts];
    newPorts[index] = { ...newPorts[index], ...newData };
    set({ currentPorts: newPorts });
  },

  movePort: (index, axis, delta) => {
    const newPorts = [...get().currentPorts];
    const p = [...newPorts[index].position];
    p[axis] += delta;
    newPorts[index].position = p as any;
    set({ currentPorts: newPorts });
  },

  snapPortToGrid: (index) => {
    log(`Snap port [${index}] to 20-LDU grid`, 'PHYSICS');
    const newPorts = [...get().currentPorts];
    const p = newPorts[index].position.map(v => Math.round(v / 20) * 20);
    newPorts[index].position = p as any;
    set({ currentPorts: newPorts });
  },

  flipPortZ: (index) => {
    log(`Flipping port [${index}] Z-axis (Reverse orientation)`, 'ACTION');
    const newPorts = [...get().currentPorts];
    const rot = newPorts[index].rotation;
    // 绕 Y 轴旋转 180 度来翻转 Z 轴
    const flipMat = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
    const newRot = [
      [rot[0][0]*flipMat[0][0], rot[0][1]*flipMat[1][1], rot[0][2]*flipMat[2][2]],
      [rot[1][0]*flipMat[0][0], rot[1][1]*flipMat[1][1], rot[1][2]*flipMat[2][2]],
      [rot[2][0]*flipMat[0][0], rot[2][1]*flipMat[1][1], rot[2][2]*flipMat[2][2]]
    ];
    newPorts[index].rotation = newRot;
    set({ currentPorts: newPorts });
  },

  rotatePort90: (index) => {
    log(`Rotating port [${index}] 90-deg around Y`, 'ACTION');
    const newPorts = [...get().currentPorts];
    const rot = newPorts[index].rotation;
    const rotateMat = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]; // Ry(90)
    const newRot = [
        [rot[0][0]*rotateMat[0][0] + rot[0][2]*rotateMat[2][0], rot[0][1], rot[0][0]*rotateMat[0][2] + rot[0][2]*rotateMat[2][2]],
        [rot[1][0]*rotateMat[0][0] + rot[1][2]*rotateMat[2][0], rot[1][1], rot[1][0]*rotateMat[0][2] + rot[1][2]*rotateMat[2][2]],
        [rot[2][0]*rotateMat[0][0] + rot[2][2]*rotateMat[2][0], rot[2][1], rot[2][0]*rotateMat[0][2] + rot[2][2]*rotateMat[2][2]]
    ];
    newPorts[index].rotation = newRot;
    set({ currentPorts: newPorts });
  },

  rotateX90: (index) => {
    log(`Rotation: RX(90) on port [${index}]`, 'ACTION');
    const newPorts = [...get().currentPorts];
    const rot = newPorts[index].rotation;
    const rx = [[1,0,0],[0,0,1],[0,-1,0]];
    const res = [[0,0,0],[0,0,0],[0,0,0]];
    for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++) res[r][c] += rot[r][k]*rx[k][c];
    newPorts[index].rotation = res;
    set({ currentPorts: newPorts });
  },

  rotateY90: (index) => {
    log(`Rotation: RY(90) on port [${index}]`, 'ACTION');
    const newPorts = [...get().currentPorts];
    const rot = newPorts[index].rotation;
    const ry = [[0,0,1],[0,1,0],[-1,0,0]];
    const res = [[0,0,0],[0,0,0],[0,0,0]];
    for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++) res[r][c] += rot[r][k]*ry[k][c];
    newPorts[index].rotation = res;
    set({ currentPorts: newPorts });
  },

  rotateZ90: (index) => {
    log(`Rotation: RZ(90) on port [${index}]`, 'ACTION');
    const newPorts = [...get().currentPorts];
    const rot = newPorts[index].rotation;
    const rz = [[0,1,0],[-1,0,0],[0,0,1]];
    const res = [[0,0,0],[0,0,0],[0,0,0]];
    for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++) res[r][c] += rot[r][k]*rz[k][c];
    newPorts[index].rotation = res;
    set({ currentPorts: newPorts });
  },

  saveVerification: async () => {
    const { currentPartId, currentPorts } = get();
    if (!currentPartId) return;
    
    log(`Submitting verification for ${currentPartId}...`, 'ACTION');
    set({ isLoading: true });
    
    /** 
     * 持久化单位大一统 [Persistence Logic]:
     * - Workbench 工作台内部所有位置坐标均采用 [LDU (LDraw Units)]，以便于格点吸附(20-LDU)。
     * - 入库(JSON)前，必须统一转换为 [SI Meters (米)]，公式 = LDU * 0.0004。
     * - 这保证了仿真引擎后端可以直接加载这些真实物理位移数据。
     */
    const SI_METERS_CONV = 0.0004;
    const portsToSave = currentPorts.map(p => ({
      ...p,
      position: p.position.map(v => v * SI_METERS_CONV)
    }));
    
    try {
      const resp = await fetch(`${API_BASE}/verify/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ part_id: currentPartId, ports: portsToSave })
      });
      if (resp.ok) {
        log(`Verification SAVED successfully for ${currentPartId}`, 'INFO');
        // 宏观体验：成功后不仅要刷新列表，还要清空当前编辑区，给用户“任务完成”的明确暗示
        set({ currentPartId: null, currentPorts: [] });
        await get().fetchPendingList();
        
        // 关键补丁：强制清理该零件的所有本地 UI 缓存，确保切回组装视图时能拉到全新的米制数据
        clearPartCache(currentPartId);
        
        // 增加浏览器级物理弹窗，防止用户错过状态变更
        window.alert(`✅ 【${currentPartId}】 已成功提交复核！`);
      } else {
        const errText = await resp.text();
        log(`Failed to save: ${errText}`, 'ERROR');
        window.alert(`❌ 保存失败: ${errText}`);
      }
    } catch (e) {
      log(`Network error during save: ${e}`, 'ERROR');
      window.alert(`❌ 网络错误: ${e}`);
    } finally {
      set({ isLoading: false });
    }
  }
}));

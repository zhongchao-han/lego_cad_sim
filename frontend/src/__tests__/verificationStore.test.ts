/**
 * verificationStore.test.ts
 * =========================
 * 审计 Round 3-B — 整文件 0 单测，覆盖：
 *   - saveVerification: LDU→SI 米转换 (×0.0004) + 0.1mm 贪心聚类 site
 *   - 旋转矩阵 rotateX/Y/Z90 正交性
 *   - flipPortZ / snapPortToGrid / addPort / deletePort 状态机契约
 *
 * mock global.fetch + window.alert（saveVerification 走 fetch + window.alert，
 * 不能在 jsdom 直接放过）。
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useVerificationStore } from '../verificationStore';

const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

beforeEach(() => {
  // 重置 store 到初始态
  useVerificationStore.setState({
    pendingList: [],
    searchList: [],
    currentPartId: null,
    currentPorts: [],
    isLoading: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// 旋转矩阵正交性 — rotateX/Y/Z 90°
// ─────────────────────────────────────────────────────────────────────────
function isOrthogonal(m: number[][], eps = 1e-9): boolean {
  // 列向量两两正交且长度为 1
  for (let i = 0; i < 3; i++) {
    let lenSq = 0;
    for (let r = 0; r < 3; r++) lenSq += m[r][i] * m[r][i];
    if (Math.abs(lenSq - 1) > eps) return false;
  }
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      let dot = 0;
      for (let r = 0; r < 3; r++) dot += m[r][i] * m[r][j];
      if (Math.abs(dot) > eps) return false;
    }
  }
  return true;
}

describe('verificationStore — 旋转矩阵正交性', () => {
  it('case 1: rotateX90 保持正交且 4 次回到 identity', () => {
    useVerificationStore.setState({
      currentPorts: [{ name: 'p', type: 'peg', position: [0, 0, 0], rotation: EYE3 }],
    });
    for (let i = 0; i < 4; i++) {
      useVerificationStore.getState().rotateX90(0);
      expect(isOrthogonal(useVerificationStore.getState().currentPorts[0].rotation)).toBe(true);
    }
    // 4 次 90° 回 identity
    const r = useVerificationStore.getState().currentPorts[0].rotation;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(r[i][j]).toBeCloseTo(EYE3[i][j], 6);
      }
    }
  });

  it('case 2: rotateY90 / rotateZ90 同样保持正交', () => {
    useVerificationStore.setState({
      currentPorts: [{ name: 'p', type: 'peg', position: [0, 0, 0], rotation: EYE3 }],
    });
    useVerificationStore.getState().rotateY90(0);
    expect(isOrthogonal(useVerificationStore.getState().currentPorts[0].rotation)).toBe(true);
    useVerificationStore.getState().rotateZ90(0);
    expect(isOrthogonal(useVerificationStore.getState().currentPorts[0].rotation)).toBe(true);
  });

  it('case 3: rotateZ90 + is_manually_adjusted 标记', () => {
    useVerificationStore.setState({
      currentPorts: [{ name: 'p', type: 'peg', position: [0, 0, 0], rotation: EYE3 }],
    });
    useVerificationStore.getState().rotateZ90(0);
    expect(useVerificationStore.getState().currentPorts[0].is_manually_adjusted).toBe(true);
  });

  it('case 4: flipPortZ 翻 Z 列 — Z 列符号反转，X/Y 列不变', () => {
    useVerificationStore.setState({
      currentPorts: [{ name: 'p', type: 'peg', position: [0, 0, 0], rotation: EYE3 }],
    });
    useVerificationStore.getState().flipPortZ(0);
    const r = useVerificationStore.getState().currentPorts[0].rotation;
    // Z 列 [0,0,1] → [0,0,-1]
    expect(r[2][2]).toBe(-1);
    // X 列 [1,0,0] 应反 X 符号 (因为 flipMat[0][0]=-1)
    expect(r[0][0]).toBe(-1);
    expect(isOrthogonal(r)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// snapPortToGrid + 状态契约
// ─────────────────────────────────────────────────────────────────────────
describe('verificationStore — snapPortToGrid + addPort + deletePort', () => {
  it('case 5: snapPortToGrid 把 LDU 坐标量化到 20-LDU 网格', () => {
    useVerificationStore.setState({
      currentPorts: [{ name: 'p', type: 'peg', position: [9, 15, 31], rotation: EYE3 }],
    });
    useVerificationStore.getState().snapPortToGrid(0);
    expect(useVerificationStore.getState().currentPorts[0].position).toEqual([0, 20, 40]);
    expect(useVerificationStore.getState().currentPorts[0].is_manually_adjusted).toBe(true);
  });

  it('case 6: addPort 加新 port 到末尾 + name 含 timestamp', () => {
    useVerificationStore.getState().addPort('peghole');
    const ports = useVerificationStore.getState().currentPorts;
    expect(ports.length).toBe(1);
    expect(ports[0].type).toBe('peghole.dat');
    expect(ports[0].name).toMatch(/^manual_\d+$/);
  });

  it('case 7: deletePort 按 index 删除', () => {
    useVerificationStore.setState({
      currentPorts: [
        { name: 'a', type: 'peg', position: [0, 0, 0], rotation: EYE3 },
        { name: 'b', type: 'peg', position: [0, 0, 0], rotation: EYE3 },
        { name: 'c', type: 'peg', position: [0, 0, 0], rotation: EYE3 },
      ],
    });
    useVerificationStore.getState().deletePort(1);
    const ports = useVerificationStore.getState().currentPorts;
    expect(ports.length).toBe(2);
    expect(ports.map(p => p.name)).toEqual(['a', 'c']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// saveVerification — LDU→SI + 贪心聚类
// ─────────────────────────────────────────────────────────────────────────
describe('verificationStore — saveVerification LDU→SI + site 聚类', () => {
  beforeEach(() => {
    // mock window.alert (jsdom 不实现)
    Object.defineProperty(window, 'alert', { value: vi.fn(), writable: true });
  });

  it('case 8: 单 port LDU 20 → SI 0.008m，单 site', async () => {
    let postedBody: any = null;
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (typeof url === 'string' && url.includes('/verify/save')) {
        postedBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, text: () => Promise.resolve('ok') });
      }
      // pending_list refetch
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }) as any;

    useVerificationStore.setState({
      currentPartId: '3001',
      currentPorts: [{ name: 'p1', type: 'peg', position: [20, 0, 0], rotation: EYE3 }],
    });
    await useVerificationStore.getState().saveVerification();

    expect(postedBody).toBeDefined();
    expect(postedBody.part_id).toBe('3001');
    expect(postedBody.sites.length).toBe(1);
    expect(postedBody.sites[0].position[0]).toBeCloseTo(0.008, 6); // 20 LDU × 0.0004 = 0.008m
    expect(postedBody.sites[0].ports.length).toBe(1);
  });

  it('case 9: 两 port 距离 < 0.1mm (LDU 0.2 < 0.25 LDU) → 合并为 1 site', async () => {
    let postedBody: any = null;
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (typeof url === 'string' && url.includes('/verify/save')) {
        postedBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, text: () => Promise.resolve('ok') });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }) as any;

    // 两 port LDU 距离 0.2 → SI 0.2*0.0004=8e-5 m < threshold 1e-4
    useVerificationStore.setState({
      currentPartId: 'X',
      currentPorts: [
        { name: 'a', type: 'peg', position: [10, 0, 0], rotation: EYE3 },
        { name: 'b', type: 'peg', position: [10.2, 0, 0], rotation: EYE3 },
      ],
    });
    await useVerificationStore.getState().saveVerification();
    expect(postedBody.sites.length).toBe(1);
    expect(postedBody.sites[0].ports.length).toBe(2);
  });

  it('case 10: 两 port 距离 > 0.1mm (LDU 1.0 → 4e-4 m > 1e-4) → 2 site 独立', async () => {
    let postedBody: any = null;
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (typeof url === 'string' && url.includes('/verify/save')) {
        postedBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, text: () => Promise.resolve('ok') });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }) as any;

    useVerificationStore.setState({
      currentPartId: 'X',
      currentPorts: [
        { name: 'a', type: 'peg', position: [0, 0, 0], rotation: EYE3 },
        { name: 'b', type: 'peg', position: [1, 0, 0], rotation: EYE3 },
      ],
    });
    await useVerificationStore.getState().saveVerification();
    expect(postedBody.sites.length).toBe(2);
    expect(postedBody.sites[0].id).toBe('X_site0');
    expect(postedBody.sites[1].id).toBe('X_site1');
  });

  it('case 11: 成功后清 currentPartId/Ports', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/verify/save')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }) as any;

    useVerificationStore.setState({
      currentPartId: '3001',
      currentPorts: [{ name: 'p', type: 'peg', position: [0, 0, 0], rotation: EYE3 }],
    });
    await useVerificationStore.getState().saveVerification();
    expect(useVerificationStore.getState().currentPartId).toBeNull();
    expect(useVerificationStore.getState().currentPorts).toEqual([]);
  });

  it('case 12: currentPartId=null 时短路 — 不打 fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    useVerificationStore.setState({ currentPartId: null });
    await useVerificationStore.getState().saveVerification();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

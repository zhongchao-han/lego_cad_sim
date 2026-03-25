/**
 * store_snap_api.test.ts
 * ======================
 * 对 store.ts 中涉及后端 HTTP 调用的 Action 进行 mock 集成测试。
 *
 * 覆盖范围：
 *   - snapParts: 验证向 /api/snap_parts 发送正确的 payload（含 v3.1 world_pos 字段）
 *   - snapParts: 后端报错时前端本地状态不受影响（降级策略）
 *   - snapParts: 后端返回 auto_latched_count > 0 时日志被正确记录
 *   - toggleMode: 验证调用路径为 /api/toggle_mode（含 /api/ 前缀）
 *   - toggleMode: 后端失败时 mode 状态不发生变化
 *
 * 工具链: vitest + vi.mock('axios')
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { useStore } from '../store';
import { ZoneType, InteractionPhase } from '../types';

// ── 全局 Mock axios ──────────────────────────────────────────────────────────
vi.mock('axios');

const mockAxios = vi.mocked(axios);

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number[], number[], number[]];

function makeMockPort(partId: string, portType: string = 'peg.dat') {
  return {
    partId,
    ldrawId: partId,
    portType,
    position:    [0, 0, 0] as [number, number, number],
    rotation:    EYE3,
    globalPos:   [0.004, 0.0, 0.0] as [number, number, number],
    globalQuat:  [0, 0, 0, 1] as [number, number, number, number],
  };
}

function makeMockTargetPort(partId: string, portType: string = 'peghole.dat') {
  return {
    partId,
    ldrawId: partId,
    portType,
    position:    [0, 0.02, 0] as [number, number, number],
    rotation:    EYE3,
    globalPos:   [0.0, 0.0, 0.0] as [number, number, number],
    globalQuat:  [0, 0, 0, 1] as [number, number, number, number],
  };
}

// ── 测试套件：snapParts ────────────────────────────────────────────────────

describe('store.snapParts — 后端 API 联调', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 预设 mockStore 初始状态
    useStore.setState({
      parts: {
        'source.dat': {
          ldrawId: 'source.dat',
          position: [0.1, 0, 0],
          quaternion: [0, 0, 0, 1],
          colorCode: 7,
          zone: ZoneType.STAGED,
        },
        'target.dat': {
          ldrawId: 'target.dat',
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          colorCode: 7,
          zone: ZoneType.ACTIVE_ARENA,
        },
      },
      connections: {},
      interactionPhase: InteractionPhase.IDLE,
      logs: [],
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应向 /api/snap_parts 发送包含 parent_world_pos 的 v3.1 payload', async () => {
    // 模拟后端成功响应
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { status: 'success', auto_latched_count: 0 },
    });

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');

    const ok = await useStore.getState().snapParts(source as any, target as any);

    expect(ok).toBe(true);

    // 等待 fire-and-forget 的 Promise 完成
    await vi.waitFor(() => {
      expect(mockAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/snap_parts'),
        expect.objectContaining({
          parent_id:       'target.dat',
          child_id:        'source.dat',
          parent_world_pos: expect.any(Array),
          child_world_pos:  expect.any(Array),
        })
      );
    });
  });

  it('payload 中 parent_world_pos 应等于 target 的 globalPos', async () => {
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { status: 'success', auto_latched_count: 0 },
    });

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');
    target.globalPos = [0.01, 0.02, 0.03];

    await useStore.getState().snapParts(source as any, target as any);

    await vi.waitFor(() => {
      const call = (mockAxios.post as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/api/snap_parts')
      );
      expect(call).toBeDefined();
      expect((call as unknown[][])[1]).toMatchObject({
        parent_world_pos: [0.01, 0.02, 0.03],
      });
    });
  });

  it('后端返回 auto_latched_count=2 时 LOG 中应有 AutoLatch 相关记录', async () => {
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { status: 'success', auto_latched_count: 2 },
    });

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');

    await useStore.getState().snapParts(source as any, target as any);

    // 等待异步回调写入 log
    await vi.waitFor(() => {
      const logs = useStore.getState().logs;
      const autoLatchLog = logs.find(l => l.message.includes('AutoLatch'));
      expect(autoLatchLog).toBeDefined();
      expect(autoLatchLog?.message).toContain('2');
    });
  });

  it('后端调用失败时前端本地 parts 状态应已正确更新（降级策略）', async () => {
    (mockAxios.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Network Error')
    );

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');

    const ok = await useStore.getState().snapParts(source as any, target as any);

    // 前端本地状态必须已更新（乐观更新不回滚）
    expect(ok).toBe(true);
    const part = useStore.getState().parts['source.dat'];
    expect(part.zone).toBe(ZoneType.ACTIVE_ARENA);

    // 异步错误日志应写入
    await vi.waitFor(() => {
      const errorLogs = useStore.getState().logs.filter(l => l.type === 'ERROR');
      expect(errorLogs.length).toBeGreaterThan(0);
    });
  });

  it('后端调用失败不应改变 connections 图（本地已写入）', async () => {
    (mockAxios.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Timeout')
    );

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');

    await useStore.getState().snapParts(source as any, target as any);

    const conns = useStore.getState().connections;
    // 本地连接图应已写入
    expect(conns['source.dat']?.has('target.dat')).toBe(true);
    expect(conns['target.dat']?.has('source.dat')).toBe(true);
  });
});


// ── 测试套件：toggleMode ───────────────────────────────────────────────────

describe('store.toggleMode — 路由前缀验证', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ mode: 'ASSEMBLY', logs: [] } as any);
  });

  it('应调用含有 /api/toggle_mode 前缀的路由（修复 Bug 回归）', async () => {
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: {} });

    await useStore.getState().toggleMode();

    const calls = (mockAxios.post as ReturnType<typeof vi.fn>).mock.calls;
    const url = calls[0]?.[0] as string;
    expect(url).toContain('/api/toggle_mode');
    expect(url).not.toMatch(/^http:\/\/[^/]+\/toggle_mode/); // 不应缺少 /api/ 前缀
  });

  it('切换到 SIMULATION 成功应更新 mode 状态', async () => {
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: {} });

    await useStore.getState().toggleMode();

    expect(useStore.getState().mode).toBe('SIMULATION');
  });

  it('后端失败时 mode 状态不应改变（仍为初始 ASSEMBLY）', async () => {
    (mockAxios.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Server Error')
    );

    await useStore.getState().toggleMode();

    expect(useStore.getState().mode).toBe('ASSEMBLY');
  });

  it('切换模式后 interactionPhase 应重置为 IDLE', async () => {
    useStore.setState({ interactionPhase: InteractionPhase.SOURCE_LOCKED } as any);
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: {} });

    await useStore.getState().toggleMode();

    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
  });
});

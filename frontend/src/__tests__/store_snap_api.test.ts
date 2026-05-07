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
    // 预设 mockStore 初始状态。connections + occupiedPorts + snapPreState 都需重置，
    // 否则相邻测试中的状态会通过这三个字段渗漏（典型表现：occupiedPorts 残留导致
    // 下一测的"新端口键"被误判为"已存在"，幂等检查跳过追加）。
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
      occupiedPorts: {},
      snapPreState: null,
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
        }),
        // L56：snapParts 现在每次生成 UUID 当 Idempotency-Key
        expect.objectContaining({
          headers: expect.objectContaining({
            'Idempotency-Key': expect.any(String),
          }),
        }),
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

  it('axios.post 失败被 .catch 接住，不产生 unhandled promise rejection (issue #62 regression lock)', async () => {
    // store.ts:805 .catch 已在 commit 76d4f502 (2026-03-25) 加上，本 case 锁住
    // 现状防止未来回归。如果 .catch 被误删，await 期间 vitest unhandled rejection
    // 会让此 case 红，且 log 文本检查也会失败。
    (mockAxios.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');

    // 不应 throw，不应有 unhandled rejection
    await expect(
      useStore.getState().snapParts(source as any, target as any)
    ).resolves.toBe(true);

    // 等 fire-and-forget .catch 写入 log
    await vi.waitFor(() => {
      const log = useStore.getState().logs.find(l =>
        l.message.includes('snap_parts 调用失败') && l.message.includes('ECONNREFUSED')
      );
      expect(log).toBeDefined();
      expect(log?.type).toBe('ERROR');
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

  it('后端返回 auto_latched_edges 时应并入 connections 与 occupiedPorts', async () => {
    // 模拟一个三方 AutoLatch 场景：除了主连接 source↔target 外，
    // 后端还闭合了 source 和 第三方零件 'extra.dat' 的一条对扣边。
    // 注意：AutoLatch 边的 portKey 必须用与前端 portKey() 一致的格式。
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        status: 'success',
        auto_latched_count: 1,
        auto_latched_edges: [
          {
            src_part_id: 'source.dat',
            dst_part_id: 'extra.dat',
            // 注意：(0, 0.04, 0) 不能与主连接 source 的 srcKey 冲突
            // (主连接源端口 position=[0,0,0])
            src_port_key: '0.0000,0.0400,0.0000|0.00,0.00,1.00',
            dst_port_key: '0.0000,-0.0400,0.0000|0.00,0.00,-1.00',
          },
        ],
      },
    });

    // 预先把第三方零件放进 parts，模拟"灰板上插了销，销又通过 AutoLatch 闭合到第三件"
    useStore.setState({
      parts: {
        ...useStore.getState().parts,
        'extra.dat': {
          ldrawId: 'extra.dat',
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          colorCode: 7,
          zone: ZoneType.ACTIVE_ARENA,
        },
      },
    } as any);

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');

    await useStore.getState().snapParts(source as any, target as any);

    // 等待 fire-and-forget 的 then 把 AutoLatch 边并入状态
    await vi.waitFor(() => {
      const conns = useStore.getState().connections;
      expect(conns['source.dat']?.has('extra.dat')).toBe(true);
      expect(conns['extra.dat']?.has('source.dat')).toBe(true);
    });

    const occ = useStore.getState().occupiedPorts;
    expect(occ['source.dat']?.['0.0000,0.0400,0.0000|0.00,0.00,1.00']).toBe('extra.dat');
    expect(occ['extra.dat']?.['0.0000,-0.0400,0.0000|0.00,0.00,-1.00']).toBe('source.dat');
  });

  it('AutoLatch 边应追加到 snapPreState 以便整组撤销', async () => {
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        status: 'success',
        auto_latched_count: 1,
        auto_latched_edges: [
          {
            src_part_id: 'source.dat',
            dst_part_id: 'extra.dat',
            src_port_key: '0.0000,0.0400,0.0000|0.00,0.00,1.00',
            dst_port_key: '0.0000,-0.0400,0.0000|0.00,0.00,-1.00',
          },
        ],
      },
    });

    useStore.setState({
      parts: {
        ...useStore.getState().parts,
        'extra.dat': {
          ldrawId: 'extra.dat',
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          colorCode: 7,
          zone: ZoneType.ACTIVE_ARENA,
        },
      },
      // 模拟 handlePortClick 在 target click 时设置的 snapPreState
      snapPreState: {
        movedPartIds: ['source.dat'],
        prevPositions: {
          'source.dat': { position: [0.1, 0, 0], quaternion: [0, 0, 0, 1] },
        },
        addedConnections: [{ from: 'source.dat', to: 'target.dat' }],
        addedPartIds: [],
        addedPortKeys: [
          { partId: 'source.dat', key: '0.0000,0.0000,0.0000|0.00,0.00,1.00', peerId: 'target.dat' },
          { partId: 'target.dat', key: '0.0000,0.0200,0.0000|0.00,0.00,1.00', peerId: 'source.dat' },
        ],
      },
    } as any);

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');

    await useStore.getState().snapParts(source as any, target as any);

    await vi.waitFor(() => {
      const pre = useStore.getState().snapPreState;
      expect(pre).not.toBeNull();
      // 新增的 AutoLatch 连接应被追加（在主连接之后）
      expect(pre!.addedConnections).toEqual(
        expect.arrayContaining([
          { from: 'source.dat', to: 'target.dat' },        // 主连接（已存在）
          { from: 'source.dat', to: 'extra.dat' },          // AutoLatch 新增
        ])
      );
      // AutoLatch 端口键应被追加，不与已有的主连接键重复
      const portKeys = pre!.addedPortKeys || [];
      expect(portKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            partId: 'source.dat',
            key: '0.0000,0.0400,0.0000|0.00,0.00,1.00',
            peerId: 'extra.dat',
          }),
          expect.objectContaining({
            partId: 'extra.dat',
            key: '0.0000,-0.0400,0.0000|0.00,0.00,-1.00',
            peerId: 'source.dat',
          }),
        ])
      );
    });
  });

  it('幂等性：AutoLatch 返回已存在的边不应重复追加到 snapPreState', async () => {
    // 后端返回的边正好是主连接同一对（极端罕见但应安全）
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        status: 'success',
        auto_latched_count: 1,
        auto_latched_edges: [
          {
            src_part_id: 'source.dat',
            dst_part_id: 'target.dat',
            // 与主连接同样的 portKey
            src_port_key: '0.0000,0.0000,0.0000|0.00,0.00,1.00',
            dst_port_key: '0.0000,0.0200,0.0000|0.00,0.00,1.00',
          },
        ],
      },
    });

    useStore.setState({
      snapPreState: {
        movedPartIds: ['source.dat'],
        prevPositions: {
          'source.dat': { position: [0.1, 0, 0], quaternion: [0, 0, 0, 1] },
        },
        addedConnections: [{ from: 'source.dat', to: 'target.dat' }],
        addedPartIds: [],
        addedPortKeys: [
          { partId: 'source.dat', key: '0.0000,0.0000,0.0000|0.00,0.00,1.00', peerId: 'target.dat' },
          { partId: 'target.dat', key: '0.0000,0.0200,0.0000|0.00,0.00,1.00', peerId: 'source.dat' },
        ],
      },
    } as any);

    const source = makeMockPort('source.dat');
    const target = makeMockTargetPort('target.dat');

    await useStore.getState().snapParts(source as any, target as any);

    // 给 axios 回调一点时间执行
    await new Promise(r => setTimeout(r, 10));

    const pre = useStore.getState().snapPreState!;
    // addedConnections 应仍只有一条（不重复）
    const sourceTargetConns = pre.addedConnections.filter(
      c => (c.from === 'source.dat' && c.to === 'target.dat') ||
           (c.from === 'target.dat' && c.to === 'source.dat')
    );
    expect(sourceTargetConns.length).toBe(1);
    // addedPortKeys 应仍只有 2 条（src + dst 各一）
    expect((pre.addedPortKeys || []).length).toBe(2);
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

  // ─── issue #63 fix：modeToggleError + modeToggling 字段 ───────────────────
  it('toggleMode 失败时 modeToggleError 设为 error message (issue #63)', async () => {
    useStore.setState({ modeToggleError: null, modeToggling: false } as any);
    (mockAxios.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Backend 5xx')
    );
    await useStore.getState().toggleMode();
    expect(useStore.getState().modeToggleError).toContain('Backend 5xx');
    expect(useStore.getState().modeToggling).toBe(false);
    expect(useStore.getState().mode).toBe('ASSEMBLY'); // 失败 mode 不变
  });

  it('toggleMode 成功后 modeToggleError 被清回 null', async () => {
    // 先制造一次失败把 modeToggleError 设上
    useStore.setState({ modeToggleError: 'previous failure', modeToggling: false } as any);
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: {} });
    await useStore.getState().toggleMode();
    expect(useStore.getState().modeToggleError).toBeNull();
  });

  it('toggleMode 进行中再调被早退 (modeToggling 防双击)', async () => {
    // 第一次调用 — 让 axios 阻塞在 pending promise
    let resolveFirst: ((v: any) => void) | undefined;
    (mockAxios.post as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise(r => { resolveFirst = r; })
    );
    const firstCall = useStore.getState().toggleMode();
    // axios 仍未 resolve，modeToggling 应 true
    expect(useStore.getState().modeToggling).toBe(true);

    // 第二次调用应被早退（不发新 axios 请求）
    await useStore.getState().toggleMode();
    expect((mockAxios.post as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // resolve 第一次 → 切换完成 + modeToggling=false
    resolveFirst?.({ data: {} });
    await firstCall;
    expect(useStore.getState().modeToggling).toBe(false);
    expect(useStore.getState().mode).toBe('SIMULATION');
  });
});

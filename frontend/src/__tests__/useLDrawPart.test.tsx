/**
 * useLDrawPart.test.tsx
 * =====================
 * 审计 Round 3-B — useLDrawPart hook 0 直接单测，覆盖：
 *   - partId=null/undefined 短路 (loading=false)
 *   - 首次 fetch 成功路径 + cache 写入
 *   - 第二次同 partId/colorCode/includePending → cache 命中，axios 不重 call
 *   - 不同 colorCode → cacheKey 不同 → 重 fetch
 *   - 失败路径写 error state + cache 仍写入（不重试）
 *   - clearPartCache 前缀 startsWith bug — partId="3001" 误删 "30015"（issue 待立）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useLDrawPart, clearPartCache, clearAllPartCache } from '../useLDrawPart';

vi.mock('axios');
const mockAxios = vi.mocked(axios);

describe('useLDrawPart — fetch + cache + cancelled race', () => {
  beforeEach(() => {
    clearAllPartCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('case 1: partId=null → 立即 loading=false，不发 axios', () => {
    const { result } = renderHook(() => useLDrawPart(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.ports).toEqual([]);
    expect(mockAxios.get).not.toHaveBeenCalled();
  });

  it('case 2: 首次 fetch 成功 → state 更新 + axios called once + cache 写入', async () => {
    (mockAxios.get as any).mockResolvedValueOnce({
      data: {
        ports: [{ name: 'p1', type: 'peg', position: [0, 0, 0], rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }],
        sites: [],
        mesh_url: '/mesh/3001.glb',
      },
    });
    const { result } = renderHook(() => useLDrawPart('3001'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.ports.length).toBe(1);
    });
    expect(mockAxios.get).toHaveBeenCalledTimes(1);
    expect(result.current.meshUrl).toBe('/mesh/3001.glb');
  });

  it('case 3: 同 partId/colorCode/includePending → cache 命中，axios 仅一次', async () => {
    (mockAxios.get as any).mockResolvedValueOnce({
      data: { ports: [], sites: [], mesh_url: '/m' },
    });
    const { result: r1, unmount: u1 } = renderHook(() => useLDrawPart('3001'));
    await waitFor(() => expect(r1.current.loading).toBe(false));
    u1();

    // 第二次 hook 不应重 fetch
    const { result: r2 } = renderHook(() => useLDrawPart('3001'));
    expect(r2.current.loading).toBe(false); // 立即从 cache 读
    expect(mockAxios.get).toHaveBeenCalledTimes(1);
  });

  it('case 4: 不同 colorCode → cacheKey 不同 → 重 fetch', async () => {
    (mockAxios.get as any)
      .mockResolvedValueOnce({ data: { ports: [], sites: [], mesh_url: '/red' } })
      .mockResolvedValueOnce({ data: { ports: [], sites: [], mesh_url: '/blue' } });
    const { result: r1 } = renderHook(() => useLDrawPart('3001', 4));
    await waitFor(() => expect(r1.current.loading).toBe(false));

    const { result: r2 } = renderHook(() => useLDrawPart('3001', 1));
    await waitFor(() => expect(r2.current.loading).toBe(false));
    expect(mockAxios.get).toHaveBeenCalledTimes(2);
    expect(r1.current.meshUrl).toBe('/red');
    expect(r2.current.meshUrl).toBe('/blue');
  });

  it('case 5: 失败路径 → state.error 设 + cache 写入失败态（不重试）', async () => {
    (mockAxios.get as any).mockRejectedValueOnce(new Error('Network down'));
    const { result } = renderHook(() => useLDrawPart('999'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toContain('Network down');
    });

    // 第二次 hook 同 partId — 应走 cache，不重新发请求
    (mockAxios.get as any).mockClear();
    const { result: r2 } = renderHook(() => useLDrawPart('999'));
    expect(r2.current.error).toContain('Network down');
    expect(mockAxios.get).not.toHaveBeenCalled();
  });

  it('case 6: clearPartCache 用 `${partId}_` 前缀 — partId="3001" 不误删 "30015" (修自 issue #75)', async () => {
    // 修复后 clearPartCache 用 startsWith(partId+"_") 严格前缀匹配，
    // "3001" 不再误命中 "30015_c7_p0"。
    (mockAxios.get as any).mockResolvedValue({ data: { ports: [], sites: [], mesh_url: '/m' } });

    const { result: r1 } = renderHook(() => useLDrawPart('3001'));
    await waitFor(() => expect(r1.current.loading).toBe(false));
    const { result: r2 } = renderHook(() => useLDrawPart('30015'));
    await waitFor(() => expect(r2.current.loading).toBe(false));
    expect(mockAxios.get).toHaveBeenCalledTimes(2);

    // clear "3001" — 仅清 "3001_*"，"30015_*" 保留
    clearPartCache('3001');
    (mockAxios.get as any).mockClear();

    // "30015" 应仍命中 cache，不重新 fetch
    const { result: r3 } = renderHook(() => useLDrawPart('30015'));
    await waitFor(() => expect(r3.current.loading).toBe(false));
    expect(mockAxios.get).not.toHaveBeenCalled();

    // 反向验证：被 clear 的 "3001" 重 hook 应重新 fetch
    const { result: r4 } = renderHook(() => useLDrawPart('3001'));
    await waitFor(() => expect(r4.current.loading).toBe(false));
    expect(mockAxios.get).toHaveBeenCalledTimes(1);
  });

  it('case 7: clearAllPartCache 清掉所有 cache key', async () => {
    (mockAxios.get as any).mockResolvedValue({ data: { ports: [], sites: [], mesh_url: '/m' } });

    const { result: r1 } = renderHook(() => useLDrawPart('3001'));
    await waitFor(() => expect(r1.current.loading).toBe(false));
    clearAllPartCache();
    (mockAxios.get as any).mockClear();

    const { result: r2 } = renderHook(() => useLDrawPart('3001'));
    await waitFor(() => expect(r2.current.loading).toBe(false));
    expect(mockAxios.get).toHaveBeenCalledTimes(1);
  });
});

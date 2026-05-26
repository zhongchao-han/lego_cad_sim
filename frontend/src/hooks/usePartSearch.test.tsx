import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePartSearch } from './usePartSearch';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// debounce 同步化，便于断言
vi.mock('lodash.debounce', () => {
  return {
    default: vi.fn((fn) => {
      const d = (...args: any[]) => fn(...args);
      d.cancel = vi.fn();
      return d;
    }),
  };
});

describe('usePartSearch（本地向量语义搜索）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('1. 空 query 不发请求，结果清空', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePartSearch());
    act(() => {
      result.current.handleQueryChange({ target: { value: '   ' } } as React.ChangeEvent<HTMLInputElement>);
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it('2. 有 query 时 POST /api/search 并回填结果', async () => {
    const hit = {
      id: '2855', part_num: '2855', name: 'Turntable Type 1 Top',
      zh_name: '转盘', zh_desc: 'turntable 型 1 顶', status: 'verified', confidence: 1.0,
      thumbnail_url: '/api/thumbnails/2855.png', score: 0.91,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', hits: [hit] }),
    });
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePartSearch());
    act(() => {
      result.current.handleQueryChange({ target: { value: '起重机旋转的那种大齿轮' } } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(1);
    }, { timeout: 2000, interval: 50 });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/search'));
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as any).body);
    expect(body.query).toBe('起重机旋转的那种大齿轮');
    expect(result.current.results[0].part_num).toBe('2855');
  });

  it('3. 后端返回 error 时设置 error 状态、清空结果', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'error', msg: '向量索引缺失', hits: [] }),
    });
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePartSearch());
    act(() => {
      result.current.handleQueryChange({ target: { value: 'plate' } } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      expect(result.current.error).toContain('向量索引缺失');
    }, { timeout: 2000, interval: 50 });
    expect(result.current.results).toEqual([]);
  });

  it('4. HTTP 错误时 error 含状态码', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({}),
    });
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePartSearch());
    act(() => {
      result.current.handleQueryChange({ target: { value: 'gear' } } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      expect(result.current.error).toContain('500');
    }, { timeout: 2000, interval: 50 });
  });
});

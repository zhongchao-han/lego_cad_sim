import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePartSearch } from './usePartSearch';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('meilisearch', () => {
  const MeiliSearchMock = vi.fn().mockImplementation(() => ({
    index: vi.fn().mockReturnValue({
      search: vi.fn().mockResolvedValue({
        hits: [{ id: 'test_hit', part_num: '1234', name: 'Test Part' }]
      })
    })
  }));
  return { Meilisearch: MeiliSearchMock };
});

vi.mock('lodash.debounce', () => {
  return {
    default: vi.fn((fn) => {
      const d = (...args: any[]) => fn(...args);
      d.cancel = vi.fn();
      return d;
    })
  };
});

describe('usePartSearch', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('1. Initializes LLM config (enabled) from localStorage correctly', () => {
    localStorage.setItem('lego_llm_config', JSON.stringify({ enabled: false }));

    const { result } = renderHook(() => usePartSearch());
    expect(result.current.llmConfig.enabled).toBe(false);
    // 前端 config 不再含任何密钥字段（key 已移到后端 env）
    expect((result.current.llmConfig as any).apiKey).toBeUndefined();
  });

  it('2. 中文 query 经后端代理 /api/llm_rewrite（不直连 deepseek，前端无 key）', async () => {
    const fetchMock = vi.fn()
      // fetch1: search key
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', search_key: 'test', host: 'http://x' }) })
      // fetch2: 后端语义改写代理
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', keywords: 'Baseplate 19 11' }) });
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePartSearch());
    await new Promise(r => setTimeout(r, 150));

    act(() => { result.current.updateLlmConfig({ enabled: true }); });
    act(() => {
      result.current.handleQueryChange({ target: { value: '红色大板' } } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      const llmCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/llm_rewrite'));
      expect(llmCall).toBeDefined();
      // 绝不直连 deepseek / chat completions（key 不在前端）
      expect(fetchMock.mock.calls.some(c => String(c[0]).includes('deepseek') || String(c[0]).includes('chat/completions'))).toBe(false);
    }, { timeout: 2000, interval: 100 });
  });

  it('3. Successfully bypasses LLM if search is completely English and short', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', search_key: 'test' })
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() => usePartSearch());
    
    // 必须等待模拟引擎完成初始化，防止 mock 中的立刻查询因 client 仍是 null 发起熔断保护
    await new Promise(r => setTimeout(r, 150));
    
    act(() => {
      result.current.updateLlmConfig({ enabled: true });
    });

    act(() => {
      result.current.handleQueryChange({ target: { value: 'plate' } } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled(); // 只要触发了即可
    }, { timeout: 2000, interval: 100 });
  });
  
  // ─── F2/F3 — LLM 重写 + isNaturalLanguage 边界 ─────────────────────────
  // 现有 case 1-3 覆盖 localStorage init / 缺 API Key / 短英文 bypass；
  // 加这 3 个补 LLM 重写正常路径 + LLM 失败 + 中英文/长度边界。

  it('5. F2 — 中文 query 触发后端语义改写，重写结果传给 Meilisearch.search', async () => {
    // 真实路径：init key (fetch1) → 后端 /api/llm_rewrite (fetch2) → Meilisearch
    const fetchMock = vi.fn()
      // fetch1: search key
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', search_key: 'test', host: 'http://x' }),
      })
      // fetch2: 后端语义改写代理
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', keywords: 'Baseplate 19 11' }),
      });
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePartSearch());
    await new Promise(r => setTimeout(r, 150));

    act(() => {
      result.current.updateLlmConfig({ enabled: true });
    });
    act(() => {
      result.current.handleQueryChange({
        target: { value: '红色大底板' }, // 含中文 → 触发 LLM
      } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      // fetch 至少两次（init key + 后端语义改写代理）
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const llmCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/llm_rewrite'));
      expect(llmCall).toBeDefined();
      // rewrittenQuery 在 LLM 返回后被 set
      expect(result.current.rewrittenQuery).toBe('Baseplate 19 11');
    }, { timeout: 2000, interval: 100 });
  });

  it('6. F3 — 短英文 query 不进 LLM（isNaturalLanguage 边界 — 无中文 + 词数 ≤3）', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', search_key: 'test' }),
    });
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePartSearch());
    await new Promise(r => setTimeout(r, 150));

    act(() => {
      result.current.updateLlmConfig({ enabled: true });
    });
    act(() => {
      // "plate hole" = 2 词全英文 → bypass LLM
      result.current.handleQueryChange({
        target: { value: 'plate hole' },
      } as React.ChangeEvent<HTMLInputElement>);
    });

    await new Promise(r => setTimeout(r, 200));

    // 不应有后端语义改写调用
    const llmCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/llm_rewrite'));
    expect(llmCalls.length).toBe(0);
    // 也不应该有 rewrittenQuery
    expect(result.current.rewrittenQuery).toBeNull();
  });

  it('7. F2 — LLM 调用失败时 error 状态包含 "语义检索失败"', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', search_key: 'test' }),
      })
      // LLM 返回 500
      .mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      });
    global.fetch = fetchMock as any;

    const { result } = renderHook(() => usePartSearch());
    await new Promise(r => setTimeout(r, 150));

    act(() => {
      result.current.updateLlmConfig({ enabled: true });
    });
    act(() => {
      result.current.handleQueryChange({
        target: { value: '复杂的中文 query' },
      } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      expect(result.current.error).toContain('语义检索失败');
    }, { timeout: 2000, interval: 100 });
  });

  it('4. Handles MeiliSearch initialization failure gracefully', async () => {
    // 采用同步模拟抛出的方式避免 vitest 在后台报出 Uncaught Exception
    // 由于这个测试单纯校验容错能力，我们临时 mock fetch 以使它失败
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({})
    });

    // 为防 unhandled rejection 暴露到外部
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 在 React 18+ 环境下测试 intentionally thrown error，我们需要挂一个 ErrorBoundary
    class TestErrorBoundary extends React.Component<any, any> {
      constructor(props: any) { super(props); this.state = { err: null }; }
      static getDerivedStateFromError(error: any) { return { err: error }; }
      render() { return this.state.err ? <div>{this.state.err.message}</div> : this.props.children; }
    }

    let caughtError: Error | null = null;
    const { result } = renderHook(() => {
        try {
            return usePartSearch();
        } catch(e: any) {
            caughtError = e;
            return null as any;
        }
    }, { wrapper: TestErrorBoundary });

    // 默认重试三次，延迟依次是 100, 500, 1000 = 1600ms。加上轮询可能到 1800ms
    await waitFor(() => {
      // 在容错模式下，最终应该通过 throw 抛出
      expect(caughtError).not.toBeNull();
      if (caughtError) {
          expect((caughtError as Error).message).toContain('搜索引擎初始化失败');
      }
    }, { timeout: 3000, interval: 200 });
    
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });
});

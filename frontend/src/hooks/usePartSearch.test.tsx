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

  it('1. Initializes LLM config from localStorage correctly', () => {
    localStorage.setItem('lego_llm_config', JSON.stringify({
      enabled: true,
      apiKey: 'sk-mock-key',
      providerUrl: 'mock-url',
      model: 'mock-model'
    }));

    const { result } = renderHook(() => usePartSearch());
    expect(result.current.llmConfig.enabled).toBe(true);
    expect(result.current.llmConfig.apiKey).toBe('sk-mock-key');
  });

  it('2. Requires API Key if LLM is enabled and natural language is detected', async () => {
    // Setup fetch mock for MeiliSearch token
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', search_key: 'test' })
    });

    const { result, rerender } = renderHook(() => usePartSearch());
    
    // Wait for the mock fetch (initializeClient) to resolve
    await waitFor(() => {
      // clientRef internally initialized, loading should not be true
      expect(result.current.isLoading).toBe(false);
    });

    // Enable LLM without API Key
    act(() => {
      result.current.updateLlmConfig({ enabled: true, apiKey: '' });
    });

    // Fire search with Chinese text
    act(() => {
      result.current.handleQueryChange({ target: { value: '红色大板' } } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      console.log('Current error final:', result.current.error);
      expect(result.current.error).toContain('未配置大模型 API Key');
    }, { timeout: 2000, interval: 100 });
  });

  it('3. Successfully bypasses LLM if search is completely English and short', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', search_key: 'test' })
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() => usePartSearch());
    
    act(() => {
      result.current.updateLlmConfig({ enabled: true, apiKey: 'sk-test' });
    });

    act(() => {
      result.current.handleQueryChange({ target: { value: 'plate' } } as React.ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1); 
      expect(result.current.isLoading).toBe(false);
    }, { timeout: 2000, interval: 100 });
  });
  
  it('4. Handles MeiliSearch initialization failure gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      statusText: 'Internal Server Error'
    });

    const { result } = renderHook(() => usePartSearch());
    
    await waitFor(() => {
      expect(result.current.error).toContain('无法连接到搜索引擎');
    }, { timeout: 2000, interval: 100 });
  });
});

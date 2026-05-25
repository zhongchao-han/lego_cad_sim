import { useState, useCallback, useRef } from 'react';
import debounce from 'lodash.debounce';

const BACKEND_URL = 'http://localhost:8000';

export interface PartSearchHit {
  id: string;
  part_num: string;
  name: string;
  zh_name?: string;
  zh_desc?: string;
  category?: string;
  status: string;
  confidence: number;
  thumbnail_url: string;
  score?: number;
}

/**
 * 零件搜索：调后端本地向量语义搜索 /api/search。
 * 中文/口语描述靠向量相似度直接命中，不再需要 Meilisearch 服务或在线 LLM 改写。
 */
export function usePartSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PartSearchHit[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCounterRef = useRef<number>(0);

  // 内部实际的搜索逻辑，携带竞态控制（丢弃过期响应）
  const fetchSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    const currentCounter = ++fetchCounterRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${BACKEND_URL}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, limit: 50, verified_only: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // 过期响应直接丢弃
      if (currentCounter !== fetchCounterRef.current) return;

      if (data.status !== 'success') {
        throw new Error(data.msg || '搜索失败');
      }
      setResults((data.hits || []) as PartSearchHit[]);
    } catch (err: any) {
      if (currentCounter !== fetchCounterRef.current) return;
      console.error('Search failed:', err);
      setError(err.message || '搜索失败，请检查后端服务是否启动。');
      setResults([]);
    } finally {
      if (currentCounter === fetchCounterRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // 防抖 300ms
  const debouncedSearch = useCallback(
    debounce((nextValue: string) => fetchSearch(nextValue), 300),
    [fetchSearch]
  );

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    debouncedSearch(val);
  };

  return {
    query,
    setQuery,
    results,
    isLoading,
    error,
    handleQueryChange,
    forceSearch: (q: string) => fetchSearch(q),
  };
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { Meilisearch } from 'meilisearch';
import debounce from 'lodash.debounce';

export interface LLMConfig {
  /** 是否启用 AI 语义搜索。API key / provider / model 全部由后端 env 管理
   *  （见 backend/.env + /api/llm_rewrite），前端不再持有任何密钥。 */
  enabled: boolean;
}

const DEFAULT_LLM_CONFIG: LLMConfig = {
  enabled: true,
};

const BACKEND_URL = 'http://localhost:8000';

// Helper: 判定是否需要用大模型（如包含中文）
const isNaturalLanguage = (text: string) => /[\u4e00-\u9fa5]/.test(text) || text.split(" ").length > 3;

/**
 * 经后端代理做语义改写：中文描述 → LDraw 英文关键词。
 * 安全：DeepSeek API key 只存后端 env，前端永不接触（原先硬编码在此处已移除）。
 */
async function queryLLM(query: string): Promise<string> {
    const res = await fetch(`${BACKEND_URL}/api/llm_rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });
    if (!res.ok) {
        throw new Error(`LLM 代理 HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.status !== 'success' || !data.keywords) {
        throw new Error(data.msg || "大模型返回空结果。");
    }
    return data.keywords as string;
}

export interface PartSearchHit {
  id: string;
  part_num: string;
  name: string;
  status: string;
  confidence: number;
  thumbnail_url: string;
  _formatted?: {
    part_num: string;
    name: string;
  };
}

export function usePartSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PartSearchHit[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLlmThinking, setIsLlmThinking] = useState(false);
  const [rewrittenQuery, setRewrittenQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fatalInitError, setFatalInitError] = useState<Error | null>(null);

  // 云原生容错设计 (Fail-Fast): 防止隐式失效
  if (fatalInitError) {
    throw fatalInitError;
  }
  
  const [llmConfig, setLlmConfig] = useState<LLMConfig>(() => {
    const saved = localStorage.getItem('lego_llm_config');
    if (saved) {
      try { return { ...DEFAULT_LLM_CONFIG, ...JSON.parse(saved) }; } catch (e) {}
    }
    return DEFAULT_LLM_CONFIG;
  });

  const updateLlmConfig = (newConfig: Partial<LLMConfig>) => {
    setLlmConfig(prev => {
      const updated = { ...prev, ...newConfig };
      localStorage.setItem('lego_llm_config', JSON.stringify(updated));
      return updated;
    });
  };
  
  const clientRef = useRef<Meilisearch | null>(null);
  const fetchCounterRef = useRef<number>(0);

  // 初始化 Meilisearch 客户端（从后端换取只读 Search Key）
  useEffect(() => {
    let isMounted = true;
    
    const initializeClient = async () => {
      const delays = [100, 500, 1000]; // 指数级退避间隔
      let attempt = 0;

      while (isMounted && attempt <= delays.length) {
        try {
          const res = await fetch('http://localhost:8000/api/search/key');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();

          if (data.status === 'success' && isMounted) {
            clientRef.current = new Meilisearch({
              host: data.host || 'http://localhost:7700',
              apiKey: data.search_key,
            });
            setError(null);
            return; // 初始化成功
          } else if (isMounted) {
            throw new Error(data.msg || '后端未返回成功的凭证');
          }
        } catch (err: any) {
          if (attempt < delays.length) {
            console.warn(`[Meilisearch] 搜素引擎探针获取凭证失败，准备发起第 ${attempt + 1} 次重试...`);
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
            attempt++;
          } else {
            console.error("Failed to initialize MeiliSearch client after retries:", err);
            // 三次重试枯竭，触发致命异常
            if (isMounted) {
              setFatalInitError(new Error(`Fatal: Meilisearch 搜索引擎初始化失败，核心依赖熔断！[${err.message}]`));
            }
            break;
          }
        }
      }
    };
    
    initializeClient();
    
    return () => {
      isMounted = false;
    };
  }, []);

  // 内部实际的搜索逻辑，携带竞态控制
  const fetchSearch = useCallback(async (searchQuery: string, currentLlmConfig: LLMConfig) => {
    if (!searchQuery.trim()) {
      setResults([]);
      setIsLoading(false);
      setIsLlmThinking(false);
      setRewrittenQuery(null);
      return;
    }

    if (!clientRef.current) {
      setFatalInitError(new Error("Fatal: Meilisearch 搜索引擎未初始化完成即被并发调用，核心依赖流转异常！"));
      setIsLoading(false);
      return;
    }

    // 递增并发计数器以消除副作用（Race Condition）
    const currentCounter = ++fetchCounterRef.current;
    
    setIsLoading(true);
    setRewrittenQuery(null);
    setError(null);

    try {
      let finalQuery = searchQuery;
      // 检查大模型接管条件
      if (currentLlmConfig.enabled && isNaturalLanguage(searchQuery)) {
        setIsLlmThinking(true);
        try {
          finalQuery = await queryLLM(searchQuery);
        } catch (llmErr: any) {
          throw new Error(`语义检索失败: ${llmErr.message}`);
        }
        setIsLlmThinking(false);
        // 若在思考期间又发了新请求，阻断
        if (currentCounter !== fetchCounterRef.current) return;
        setRewrittenQuery(finalQuery);
      }

      const response = await clientRef.current.index('parts').search(finalQuery, {
        limit: 50,
        attributesToHighlight: ['part_num', 'name'],
        filter: ['status = verified'] // 默认可加上状态过滤，或由 UI 控制，此处演示基础展示
      });

      // 如果有新的请求发出，就抛弃这次过期的响应
      if (currentCounter !== fetchCounterRef.current) return;

      setResults(response.hits as PartSearchHit[]);
    } catch (err: any) {
      if (currentCounter !== fetchCounterRef.current) return;
      
      console.error("Search failed:", err);
      if (err.code === 'index_not_found') {
        setError("零件倒排索引不存在，请运行后端的数据同步脚本。");
      } else {
        setError(err.message || "搜索过程中发生错误，请检查网络或 MeiliSearch 服务。");
      }
      setResults([]);
    } finally {
      if (currentCounter === fetchCounterRef.current) {
        setIsLoading(false);
        setIsLlmThinking(false);
      }
    }
  }, []);

  // 暴露带有防抖的调用句柄给外部 UI (300ms)
  const debouncedSearch = useCallback(
    debounce((nextValue: string, config: LLMConfig) => fetchSearch(nextValue, config), llmConfig?.enabled ? 500 : 300),
    [fetchSearch, llmConfig?.enabled]
  );

  // 受控输入变化触发
  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    debouncedSearch(val, llmConfig);
  };

  return {
    query,
    setQuery,
    results,
    isLoading,
    isLlmThinking,
    rewrittenQuery,
    error,
    llmConfig,
    updateLlmConfig,
    handleQueryChange,
    forceSearch: (q: string) => fetchSearch(q, llmConfig) // 允许外部无需防抖直接触发
  };
}

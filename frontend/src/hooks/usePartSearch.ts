import { useState, useEffect, useRef, useCallback } from 'react';
import { Meilisearch } from 'meilisearch';
import debounce from 'lodash.debounce';

export interface LLMConfig {
  enabled: boolean;
  providerUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_LLM_CONFIG: LLMConfig = {
  enabled: false,
  providerUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
};

// Helper: 判定是否需要用大模型（如包含中文）
const isNaturalLanguage = (text: string) => /[\u4e00-\u9fa5]/.test(text) || text.split(" ").length > 3;

async function queryLLM(query: string, config: LLMConfig): Promise<string> {
    if (!config.apiKey) throw new Error("您开启了语义搜索，但未配置大模型 API Key。");
    const prompt = `You are a LEGO LDraw expert. The user will provide a colloquial or distinct Chinese description of a Lego part. Translate it into 1-4 concise English keywords that match standard LDraw part names (like 'Plate', 'Technic Brick', 'hole', 'Liftarm'). ONLY output the keywords, no chat, no quotes. User query: "${query}"`;
    const res = await fetch(`${config.providerUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
            model: config.model,
            messages: [{ role: "system", content: prompt }],
            temperature: 0.1,
            max_tokens: 30
        })
    });
    if (!res.ok) {
        throw new Error(`LLM Error: ${res.statusText}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Empty response from LLM.");
    return content;
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
      try {
        const res = await fetch('http://localhost:8000/api/search/key');
        if (!res.ok) throw new Error('Network response was not ok');
        const data = await res.json();
        
        if (data.status === 'success' && isMounted) {
          clientRef.current = new Meilisearch({
            host: data.host || 'http://localhost:7700',
            apiKey: data.search_key,
          });
        } else if (isMounted) {
          setError(data.msg || 'Failed to obtain Search API Key');
        }
      } catch (err) {
        if (isMounted) {
          console.error("Failed to initialize MeiliSearch client:", err);
          setError("无法连接到搜索引擎凭证服务，搜索降级不可用");
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
      setError("搜索引擎未初始化就绪。");
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
          finalQuery = await queryLLM(searchQuery, currentLlmConfig);
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

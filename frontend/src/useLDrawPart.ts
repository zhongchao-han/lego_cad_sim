import { useEffect, useState } from 'react';
import axios from 'axios';

const API_URL = (import.meta as any).env.VITE_API_URL || 'http://127.0.0.1:8000/api';

export interface LDrawPort {
  name: string;
  type: string;
  gender?: 'MALE' | 'FEMALE' | 'UNKNOWN' | string;
  position: [number, number, number];
  rotation: number[][];
  is_manually_adjusted?: boolean;
}

/** 物理坑位：共享同一中心点的一组端口（来自后端 Site 聚类） */
export interface LDrawSite {
  id: string;
  position: [number, number, number];
  occupied_by: string | null;
  ports: LDrawPort[];
}

export interface LDrawPartState {
  loading: boolean;
  error: string | null;
  ports: LDrawPort[];       // 向后兼容：扁平列表
  sites: LDrawSite[];       // 新增：聚类后的 Site 列表
  meshUrl?: string;
}

const partCache = new Map<string, LDrawPartState>();

/** 手动清除特定零件的缓存（用于保存验证结果后） */
export function clearPartCache(partId: string) {
  for (const key of partCache.keys()) {
    if (key.startsWith(partId)) {
      partCache.delete(key);
    }
  }
}

export function useLDrawPart(
  partId: string | null | undefined, 
  colorCode: number = 7, 
  includePending: boolean = false
): LDrawPartState {
  const [state, setState] = useState<LDrawPartState>(() => ({
    loading: !!partId,
    error: null,
    ports: [],
    sites: [],
    meshUrl: undefined,
  }));

  const cacheKey = partId ? `${partId}_c${colorCode}_p${includePending}` : null;

  useEffect(() => {
    if (!partId || !cacheKey) {
      setState({
        loading: false,
        error: null,
        ports: [],
        sites: [],
        meshUrl: undefined,
      });
      return;
    }

    const cached = partCache.get(cacheKey);
    if (cached) {
      setState(cached);
      return;
    }

    let cancelled = false;

    const fetchPart = async () => {
      setState({
        loading: true,
        error: null,
        ports: [],
        sites: [],
        meshUrl: undefined,
      });

      try {
        const res = await axios.get(`${API_URL}/ldraw_part/${encodeURIComponent(partId)}`, {
          params: { 
            color: colorCode,
            include_pending: includePending,
            _t: Date.now() // [v3.1 Fix] Cache-buster to guarantee we fetch the newest backend data
          },
        });
        if (cancelled) return;

        const next: LDrawPartState = {
          loading: false,
          error: null,
          ports: res.data?.ports ?? [],
          sites: res.data?.sites ?? [],
          meshUrl: res.data?.mesh_url ?? res.data?.meshUrl,
        };

        partCache.set(cacheKey, next);
        setState(next);
      } catch (err: any) {
        if (cancelled) return;
        const message = err?.message ?? 'Failed to load LDraw part data';
        const next: LDrawPartState = {
          loading: false,
          error: message,
          ports: [],
          sites: [],
          meshUrl: undefined,
        };
        partCache.set(cacheKey, next);
        setState(next);
      }
    };

    fetchPart();

    return () => {
      cancelled = true;
    };
  }, [partId, colorCode, cacheKey, includePending]);

  return state;
}


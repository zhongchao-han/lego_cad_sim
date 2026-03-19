import { useEffect, useState } from 'react';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000/api';

export interface LDrawPort {
  type: string;
  position: [number, number, number];
  rotation: number[][];
}

export interface LDrawPartState {
  loading: boolean;
  error: string | null;
  ports: LDrawPort[];
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
    meshUrl: undefined,
  }));

  const cacheKey = partId ? `${partId}_c${colorCode}_p${includePending}` : null;

  useEffect(() => {
    if (!partId || !cacheKey) {
      setState({
        loading: false,
        error: null,
        ports: [],
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
        meshUrl: undefined,
      });

      try {
        const res = await axios.get(`${API_URL}/ldraw_part/${encodeURIComponent(partId)}`, {
          params: { 
            color: colorCode,
            include_pending: includePending 
          },
        });
        if (cancelled) return;

        const next: LDrawPartState = {
          loading: false,
          error: null,
          ports: res.data?.ports ?? [],
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


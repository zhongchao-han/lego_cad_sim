import { useEffect, useState } from 'react';
import axios from 'axios';

const API_URL = 'http://127.0.0.1:8000/api';

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

export function useLDrawPart(partId: string | null | undefined): LDrawPartState {
  const [state, setState] = useState<LDrawPartState>(() => ({
    loading: !!partId,
    error: null,
    ports: [],
    meshUrl: undefined,
  }));

  useEffect(() => {
    if (!partId) {
      setState({
        loading: false,
        error: null,
        ports: [],
        meshUrl: undefined,
      });
      return;
    }

    const cached = partCache.get(partId);
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
        const res = await axios.get(`${API_URL}/ldraw_part/${encodeURIComponent(partId)}`);
        if (cancelled) return;

        const next: LDrawPartState = {
          loading: false,
          error: null,
          ports: res.data?.ports ?? [],
          meshUrl: res.data?.mesh_url ?? res.data?.meshUrl,
        };

        partCache.set(partId, next);
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
        partCache.set(partId, next);
        setState(next);
      }
    };

    fetchPart();

    return () => {
      cancelled = true;
    };
  }, [partId]);

  return state;
}


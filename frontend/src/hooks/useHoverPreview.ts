import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useHoverPreview.ts
 * ==================
 * 管理零件缩略图 hover → 3D 预览浮窗的状态（SRP）。
 *
 * - 进入缩略图后 delay(默认 350ms) 才真正展示，避免快速划过列表时
 *   连发 GLB 拉取与 Canvas mount/unmount。
 * - 记录 anchor 缩略图矩形 + 所属面板边界矩形（最近的 [data-preview-boundary]
 *   祖先），供 PartHoverPreview 把浮窗摆到面板外侧，避免盖住列表自身。
 */
export interface HoverPreviewState {
  partId: string | null;
  rect: DOMRect | null;
  boundaryRect: DOMRect | null;
}

export function useHoverPreview(delay = 350) {
  const [state, setState] = useState<HoverPreviewState>({ partId: null, rect: null, boundaryRect: null });
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const onEnter = useCallback((partId: string, el: HTMLElement) => {
    clearTimer();
    const rect = el.getBoundingClientRect();
    const boundary = el.closest('[data-preview-boundary]');
    const boundaryRect = boundary ? boundary.getBoundingClientRect() : null;
    timer.current = window.setTimeout(() => {
      setState({ partId, rect, boundaryRect });
    }, delay);
  }, [delay]);

  const onLeave = useCallback(() => {
    clearTimer();
    setState({ partId: null, rect: null, boundaryRect: null });
  }, []);

  // 卸载时清掉挂起的定时器
  useEffect(() => clearTimer, []);

  return { preview: state, onEnter, onLeave };
}

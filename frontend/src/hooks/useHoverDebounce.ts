import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * useHoverDebounce
 * 
 * 专门用于抹平 3D 渲染上下文中，因光线投射穿过复杂模型面片缝隙
 * 而引发的毫秒级 pointerOver / pointerOut 抖动。
 *
 * @param delayMs 悬停状态失效的延迟毫秒数 (默认 50ms)
 */
export function useHoverDebounce(delayMs: number = 50) {
  const [hovered, setHovered] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const onPointerOver = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setHovered(true);
  }, []);

  const onPointerOut = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = window.setTimeout(() => {
      setHovered(false);
      timeoutRef.current = null;
    }, delayMs);
  }, [delayMs]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { hovered, onPointerOver, onPointerOut };
}

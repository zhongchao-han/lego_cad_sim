import { useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

/**
 * Hover 状态的完整生命周期管理 Hook。
 *
 * 架构设计：三层防线协同工作，覆盖所有已知的 R3F/WebGL hover 丢失场景。
 *
 * 层 1：onPointerOver/Out（原生 R3F 事件）
 *   - 直接响应指针移入/移出，OUT 带 80ms 防抖过滤曲面法线边界抖动
 *
 * 层 2：Canvas pointerleave（DOM 级兜底）
 *   - 当指针飞出 WebGL 画布边界（如移入 HTML 面板）时强制清零
 *
 * 层 3：pointerup 一次性射线核实（相机旋转兜底）
 *   - OrbitControls 拖拽旋转相机后，物体在屏幕上移走但指针没动，
 *     R3F 不会触发 onPointerOut。松手后用当前相机做一次性 raycast 核实。
 *   - 与 useFrame 守卫的本质区别：只执行一次，不会与 R3F 指针系统形成反馈循环。
 */

interface UseHoverStateOptions {
  /** 零件 ID（用于日志追踪） */
  partId: string;
  /** LDraw 文件 ID（用于日志追踪） */
  ldrawId: string;
  /** 禁用事件（如 Ghost 零件） */
  disableEvents: boolean;
  /** 静态零件（如预览） */
  isStatic: boolean;
  /** hover 变化回调（可选） */
  onHoverChange?: (hovered: boolean) => void;
  /** 日志记录函数 */
  addLog: (msg: string, type?: string) => void;
  /** 零件整体 Group 的 ref（用于 post-orbit 射线核实） */
  groupRef: React.RefObject<THREE.Group | null>;
}

interface UseHoverStateReturn {
  /** 当前是否处于 hover 状态 */
  hovered: boolean;
  /** 绑定到 Group 的 onPointerOver 处理函数（当 disableEvents/isStatic 时为 undefined） */
  handlePointerOver: ((e: any) => void) | undefined;
  /** 绑定到 Group 的 onPointerOut 处理函数（当 disableEvents/isStatic 时为 undefined） */
  handlePointerOut: (() => void) | undefined;
}

/** 防抖延迟（毫秒）：过滤曲面法线边界穿越时的 OUT→IN 高频噪声 */
const DEBOUNCE_OUT_MS = 80;

/** Post-orbit 射线核实延迟（毫秒）：等待相机矩阵更新完毕 */
const POST_ORBIT_VERIFY_MS = 100;

export function useHoverState({
  partId,
  ldrawId,
  disableEvents,
  isStatic,
  onHoverChange,
  addLog,
  groupRef,
}: UseHoverStateOptions): UseHoverStateReturn {
  const [hovered, setHover] = useState(false);
  const hoveredRef = useRef(false);
  const hoverOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { mouse, camera } = useThree();

  // ── 层 1 事件处理函数 ─────────────────────────────────────────────────────

  const handlePointerOver = useCallback((e: any) => {
    e.stopPropagation();
    // 取消待定的 OUT 计时器（防止在防抖窗口内重新进入时被错误清零）
    if (hoverOutTimerRef.current !== null) {
      clearTimeout(hoverOutTimerRef.current);
      hoverOutTimerRef.current = null;
    }
    if (!hoveredRef.current) {
      hoveredRef.current = true;
      setHover(true);
      onHoverChange?.(true);
      addLog(`[InteractivePart] Hover IN: ${partId} (${ldrawId})`, 'INFO');
    }
  }, [partId, ldrawId, onHoverChange, addLog]);

  const handlePointerOut = useCallback(() => {
    // 防抖延迟：过滤曲面面片边界穿越时的 OUT→IN 高频噪声
    if (hoverOutTimerRef.current !== null) clearTimeout(hoverOutTimerRef.current);
    hoverOutTimerRef.current = setTimeout(() => {
      hoverOutTimerRef.current = null;
      hoveredRef.current = false;
      setHover(false);
      onHoverChange?.(false);
      addLog(`[InteractivePart] Hover OUT: ${partId} (${ldrawId})`, 'INFO');
    }, DEBOUNCE_OUT_MS);
  }, [partId, ldrawId, onHoverChange, addLog]);

  // ── 组件卸载时清理防抖计时器 ──────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (hoverOutTimerRef.current !== null) clearTimeout(hoverOutTimerRef.current);
    };
  }, []);

  // ── 层 2：Canvas pointerleave 兜底 ────────────────────────────────────────
  useEffect(() => {
    if (disableEvents || isStatic) return;
    const canvas = document.querySelector('canvas');
    if (!canvas) return;

    const handleCanvasLeave = () => {
      if (!hoveredRef.current) return;
      if (hoverOutTimerRef.current !== null) {
        clearTimeout(hoverOutTimerRef.current);
        hoverOutTimerRef.current = null;
      }
      hoveredRef.current = false;
      setHover(false);
      onHoverChange?.(false);
      addLog(`[InteractivePart] Canvas leave cleared hover: ${partId}`, 'INFO');
    };

    canvas.addEventListener('pointerleave', handleCanvasLeave);
    return () => canvas.removeEventListener('pointerleave', handleCanvasLeave);
  }, [disableEvents, isStatic, onHoverChange, addLog, partId]);

  // ── 层 3：Post-orbit 一次性射线核实 ───────────────────────────────────────
  useEffect(() => {
    if (disableEvents || isStatic) return;

    const handlePointerUp = () => {
      if (!hoveredRef.current || !groupRef.current) return;

      setTimeout(() => {
        if (!hoveredRef.current || !groupRef.current) return;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(mouse, camera);
        const hits = rc.intersectObject(groupRef.current, true);

        if (hits.length === 0) {
          if (hoverOutTimerRef.current !== null) {
            clearTimeout(hoverOutTimerRef.current);
            hoverOutTimerRef.current = null;
          }
          hoveredRef.current = false;
          setHover(false);
          onHoverChange?.(false);
          addLog(`[InteractivePart] Post-orbit cleared hover: ${partId}`, 'INFO');
        }
      }, POST_ORBIT_VERIFY_MS);
    };

    window.addEventListener('pointerup', handlePointerUp);
    return () => window.removeEventListener('pointerup', handlePointerUp);
  }, [disableEvents, isStatic, mouse, camera, groupRef, onHoverChange, addLog, partId]);

  // ── 返回值 ────────────────────────────────────────────────────────────────
  const isDisabled = disableEvents || isStatic;

  return {
    hovered,
    handlePointerOver: isDisabled ? undefined : handlePointerOver,
    handlePointerOut: isDisabled ? undefined : handlePointerOut,
  };
}

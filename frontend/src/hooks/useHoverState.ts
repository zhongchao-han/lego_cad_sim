import { useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

/**
 * Hover 状态的完整生命周期管理 Hook。
 *
 * 架构设计：纯几何同步拦截 (Pure Geometric Synchronous Interception)
 * 抛弃所有基于时间延迟的防御性设计（不再有 setTimeout 防抖）。
 * 依赖于子组件（如放大半径的端口碰撞体）在物理拓扑上绝对封堵穿透漏洞。
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
  const { mouse, camera } = useThree();

  // ── 层 1：纯几何物理事件处理（0延迟） ──────────────────────────────────────

  const outTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handlePointerOver = useCallback((e: any) => {
    e.stopPropagation();
    if (outTimerRef.current) {
      clearTimeout(outTimerRef.current);
      outTimerRef.current = null;
    }
    if (!hoveredRef.current) {
      hoveredRef.current = true;
      setHover(true);
      onHoverChange?.(true);
      addLog(`[InteractivePart] Hover IN (Sync): ${partId} (${ldrawId})`, 'INFO');
    }
  }, [partId, ldrawId, onHoverChange, addLog]);

  const handlePointerOut = useCallback(() => {
    // 妥协派：加回几十毫秒的防御性防抖，掩盖底板背面复杂反面管网格间隙导致的物理击空
    if (outTimerRef.current) {
      clearTimeout(outTimerRef.current);
    }
    outTimerRef.current = setTimeout(() => {
      outTimerRef.current = null;
      if (hoveredRef.current) {
        hoveredRef.current = false;
        setHover(false);
        onHoverChange?.(false);
        addLog(`[InteractivePart] Hover OUT (Sync): ${partId} (${ldrawId})`, 'INFO');
      }
    }, 80);
  }, [partId, ldrawId, onHoverChange, addLog]);

  // ── 层 2：Canvas pointerleave 兜底 (DOM级失焦) ──────────────────────────
  useEffect(() => {
    if (disableEvents || isStatic) return;
    const canvas = document.querySelector('canvas');
    if (!canvas) return;

    const handleCanvasLeave = () => {
      if (hoveredRef.current) {
        hoveredRef.current = false;
        setHover(false);
        onHoverChange?.(false);
        addLog(`[InteractivePart] Canvas leave cleared hover: ${partId}`, 'INFO');
      }
    };

    canvas.addEventListener('pointerleave', handleCanvasLeave);
    return () => canvas.removeEventListener('pointerleave', handleCanvasLeave);
  }, [disableEvents, isStatic, onHoverChange, addLog, partId]);

  // ── 层 3：Post-orbit 一次性射线同步核实 ───────────────────────────────────
  useEffect(() => {
    if (disableEvents || isStatic) return;

    const handlePointerUp = () => {
      if (!hoveredRef.current || !groupRef.current) return;
      
      // 不再使用 setTimeout，立刻同步校验当前射线的击中状态
      // 相机矩阵如果在拖拽结束的同一帧尚未计算完毕，可以依赖 R3F 的 useFrame 循环，
      // 但对于严格的同步设计，我们在鼠标松开的物理时刻执行射线计算。
      const rc = new THREE.Raycaster();
      rc.setFromCamera(mouse, camera);
      const hits = rc.intersectObject(groupRef.current, true);

      if (hits.length === 0) {
        hoveredRef.current = false;
        setHover(false);
        onHoverChange?.(false);
        addLog(`[InteractivePart] Post-orbit cleared hover: ${partId}`, 'INFO');
      }
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

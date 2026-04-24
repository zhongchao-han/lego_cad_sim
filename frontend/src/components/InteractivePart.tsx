import { memo, useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore, useIsTargetSeekingPhase } from '../store';
import { SelectionLevel, InteractionPhase, SelectedPortInfo } from '../types';
import { useLDrawPart } from '../useLDrawPart';
import { LDrawMeshRenderer } from './LDrawMeshRenderer';
import { SiteGizmo } from './SiteGizmo';
import { RenderErrorBoundary } from './RenderErrorBoundary';
import { AutoFitCamera } from './AutoFitCamera';
import { calculateClampedOffset } from '../utils/snapMath';
import { useHoverState } from '../hooks/useHoverState';
import React from 'react';

// Vite injects env into import.meta
const BACKEND_ORIGIN = (import.meta as unknown as Record<string, { VITE_BACKEND_ORIGIN?: string }>).env?.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:8000';

const encodeModelUrl = (path: string | undefined) => {
  if (!path) return null;
  return encodeURI(`${BACKEND_ORIGIN}${path}`);
};

const LDU = 0.0004;

interface InteractivePartProps {
  partId: string;
  ldrawId?: string;
  colorCode?: number;
  onPortClick?: (port: SelectedPortInfo) => void;
  onPortHover?: (port: SelectedPortInfo | null) => void;
  showPorts?: boolean;
  onHoverChange?: (h: boolean) => void;
  onDoubleClick?: () => void;
  isStatic?: boolean;
  disableEvents?: boolean;
  opacity?: number;
  autoCenter?: boolean;
  transparent?: boolean;
  position?: [number, number, number];
  quaternion?: [number, number, number, number];
  rotation?: [number, number, number];
}

export const InteractivePart = memo(({
  partId,
  ldrawId,
  colorCode = 7,
  onPortClick,
  onPortHover,
  showPorts = true,
  onHoverChange,
  onDoubleClick,
  isStatic = false,
  disableEvents = false,
  opacity = 1.0,
  autoCenter = false,
}: InteractivePartProps) => {
  const [isPortHovered, setIsPortHovered] = useState(false);
  const selection = useStore(s => s.selection);
  const interference = useStore(s => s.interferenceReport);
  const addLog = useStore((s) => s.addLog);
  const debugShowPorts = useStore(s => s.debugShowPorts);

  const isSelected = selection.primaryId === partId || (
    selection.level === SelectionLevel.GROUP && selection.allConnectedIds.includes(partId)
  );
  const isGroupMember = selection.level === SelectionLevel.GROUP && selection.allConnectedIds.includes(partId);
  const isBlocked = (selection.primaryId === partId) && interference.isBlocked;

  const [pulse, setPulse] = useState(0);
  const currentPhase = useStore(s => s.interactionPhase);
  const slidingTarget = useStore(s => s.slidingTarget);
  const selectPart = useStore(s => s.selectPart);
  const duplicateSelected = useStore(s => s.duplicateSelected);
  const updateSlideOffset = useStore(s => s.updateSlideOffset);
  const commitAxialSliding = useStore(s => s.commitAxialSliding);
  const { mouse, raycaster, camera } = useThree();

  const [forceFallback, setForceFallback] = useState(false);
  const ldrawPart = useLDrawPart(ldrawId || partId, colorCode);
  const groupRef = useRef<THREE.Group>(null);
  const meshHitboxRef = useRef<THREE.Group>(null);

  // ── Hover 状态管理（SRP：独立 Hook） ───────────────────────────────────────
  const { hovered, handlePointerOver, handlePointerOut } = useHoverState({
    partId,
    ldrawId: ldrawId || partId,
    disableEvents,
    isStatic,
    onHoverChange,
    addLog,
    groupRef,
  });

  // ── 选择/克隆交互 ─────────────────────────────────────────────────────────
  const handlePointerDown = (e: any) => {
    e.stopPropagation();

    // 如果在连续图章模式或单次放置阶段（AXIAL_SLIDING），点击零件实体应该等同于点击背景，优先提交当前深度！
    if (currentPhase === InteractionPhase.AXIAL_SLIDING) {
      commitAxialSliding();
      return;
    }

    const isMultiSelect = !!(e.shiftKey || e.metaKey || e.ctrlKey);
    // 默认点击首先选中单个零件，再次点击才扩大到整个 Group，提升操作效率
    selectPart(partId, SelectionLevel.INDIVIDUAL, isMultiSelect);
    if (e.altKey && !isMultiSelect && currentPhase === InteractionPhase.IDLE) {
      duplicateSelected();
    }
  };

  // ── 沿轴滑动由纯键盘接管（useKeyboardShortcuts） ─────────────────────────
  // 这里不再需要绑定 pointermove 和 pointerup。
  // ── 脉冲动画（干涉状态） ──────────────────────────────────────────────────
  useFrame(({ clock }) => {
    if (isBlocked) {
      setPulse(Math.sin(clock.elapsedTime * 12) * 0.4 + 0.6);
    } else if (pulse !== 0) {
      setPulse(0);
    }
  });

  // ── SiteGizmo 端口 hover 本地代理 ─────────────────────────────────────────
  const handlePortHoverLocal = useCallback((info: SelectedPortInfo | null) => {
    setIsPortHovered(!!info);
    onPortHover?.(info);
  }, [onPortHover]);

  // ── 高亮计算 ──────────────────────────────────────────────────────────────
  const highlight = useMemo(() => {
    // 穿模报错保持刺眼红光和高闪烁
    if (isBlocked) return { color: '#ff3d00', intensity: pulse, outline: false };
    
    // 选中状态：使用 CAD 级局部包围盒 (BoxHelper 线框)
    if (isSelected) return { color: null, intensity: 0, outline: true };
    if (isGroupMember) return { color: null, intensity: 0, outline: true };
    
    // 彻底贯彻“盲操”与极简美学：Hover 时不触发任何发光或高亮
    return { color: null, intensity: 0, outline: false };
  }, [isSelected, isGroupMember, isBlocked, pulse]);

  const interactionPhase = useStore(s => s.interactionPhase);
  const isTargetSeeking = useIsTargetSeekingPhase();
  const selectedPort = useStore(s => s.selectedPort);
  const continuousPlacementSource = useStore(s => s.continuousPlacementSource);
  const activeMeshUrl = useMemo(() => encodeModelUrl(ldrawPart.meshUrl), [ldrawPart.meshUrl]);

  const effectiveSourcePortType = useMemo(() => {
    if (interactionPhase === InteractionPhase.SOURCE_LOCKED) return selectedPort?.portType ?? null;
    if (interactionPhase === InteractionPhase.AXIAL_SLIDING && continuousPlacementSource) return continuousPlacementSource.portType;
    return null;
  }, [interactionPhase, selectedPort, continuousPlacementSource]);

  if (ldrawPart.loading) return null;

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  const isRenderingActive = hovered || isPortHovered || isSelected || isStatic;
  
  // 盲操模式下取消 Hover 导致的半透明，除非开启了 Debug 开关
  const finalOpacity = (debugShowPorts && (hovered || isPortHovered || isSelected)) 
    ? (opacity < 1 ? opacity : 0.5) 
    : opacity;
    
  // 端口指示器（箭头）显示逻辑：
  // 2. 如果是非 Debug 模式，遵循“极简盲操”原则：默认只有正式选中的零件会暴露端口。
  //    但是！如果当前处于寻找目标阶段（TargetSeeking），必须在悬停时显示靶点，否则用户无法吸附。
  const finalShowPorts = debugShowPorts 
    ? (showPorts && isRenderingActive)
    : (showPorts && (isSelected || isStatic || (isTargetSeeking && hovered)));

  return (
    <group
      ref={groupRef}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      <AutoFitCamera targetRef={groupRef} enabled={autoCenter && !!ldrawPart.meshUrl && !forceFallback} />

      <group ref={meshHitboxRef}>
        {ldrawPart.meshUrl && activeMeshUrl && !forceFallback ? (
          <RenderErrorBoundary onCatch={() => setForceFallback(true)}>
            <LDrawMeshRenderer
              url={activeMeshUrl}
              onDoubleClick={isStatic || disableEvents ? undefined : onDoubleClick}
              onPointerDown={isStatic || disableEvents ? undefined : handlePointerDown}
              highlightColor={highlight.color}
              highlightIntensity={highlight.intensity}
              highlightOutline={highlight.outline}
              disableRaycast={disableEvents}
              opacity={finalOpacity}
            />
          </RenderErrorBoundary>
        ) : (
          <mesh
            onDoubleClick={isStatic || disableEvents ? undefined : onDoubleClick}
            onPointerDown={isStatic || disableEvents ? undefined : handlePointerDown}
            raycast={disableEvents ? () => null : undefined}
          >
            <boxGeometry args={[10 * LDU, 10 * LDU, 10 * LDU]} />
            <meshStandardMaterial
              color={forceFallback || !!ldrawPart.error ? '#ff5252' : (highlight.color || '#b0bec5')}
              emissive={forceFallback || !!ldrawPart.error ? '#b71c1c' : (highlight.color || '#000000')}
              emissiveIntensity={forceFallback || !!ldrawPart.error ? pulse : highlight.intensity}
              transparent={finalOpacity < 1}
              opacity={finalOpacity}
            />
          </mesh>
        )}
      </group>

      {/* 始终渲染 SiteGizmo。这是纯几何无感 Hover 的核心：
          利用其内部不可见的大球壳（7 LDU）拦截穿过孔洞（6 LDU）的射线，彻底消灭穿模闪烁 Bug。
          箭头的显示与隐藏由 showVisuals 属性代理。 */}
      {ldrawPart.sites?.map((site) => (
        <SiteGizmo
          key={site.id}
          site={site}
          groupRef={groupRef as React.RefObject<THREE.Group>}
          partId={partId}
          ldrawId={ldrawId || partId}
          phase={interactionPhase}
          sourcePortType={effectiveSourcePortType}
          selectedPort={selectedPort}
          showVisuals={finalShowPorts}
          onPortClick={onPortClick}
          onPortHover={handlePortHoverLocal}
        />
      ))}
    </group>
  );
});

InteractivePart.displayName = 'InteractivePart';

import { memo, useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../store';
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
    const isMultiSelect = !!(e.shiftKey || e.metaKey || e.ctrlKey);
    selectPart(partId, SelectionLevel.GROUP, isMultiSelect);
    if (e.altKey && !isMultiSelect && currentPhase === InteractionPhase.IDLE) {
      duplicateSelected();
    }
  };

  // ── 沿轴滑动全局手势处理 ──────────────────────────────────────────────────
  useEffect(() => {
    if (currentPhase !== InteractionPhase.AXIAL_SLIDING || !isSelected || !slidingTarget) return;

    const handlePointerMove = (e: PointerEvent) => {
      const targetPos = new THREE.Vector3(...slidingTarget.globalPos);
      const targetQuat = new THREE.Quaternion(...slidingTarget.globalQuat);
      const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(targetQuat).normalize();
      const axisRay = new THREE.Ray(targetPos, axis);
      raycaster.setFromCamera(mouse, camera);
      const mouseRay = raycaster.ray;
      const closestPointOnAxis = new THREE.Vector3();
      const closestPointOnMouseRay = new THREE.Vector3();
      axisRay.distanceSqToRay(mouseRay, closestPointOnAxis, closestPointOnMouseRay);
      const diff = new THREE.Vector3().subVectors(closestPointOnAxis, targetPos);
      const offset = diff.dot(axis);
      const finalOffset = calculateClampedOffset(offset, e.shiftKey, 20 * LDU);
      updateSlideOffset(finalOffset);
    };

    const handlePointerUp = () => { commitAxialSliding(); };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [currentPhase, isSelected, slidingTarget, raycaster, mouse, camera, updateSlideOffset, commitAxialSliding]);

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
    if (isBlocked) return { color: '#ff3d00', intensity: pulse, outline: true };
    if (isSelected) return { color: null, intensity: 0, outline: true };
    if (isGroupMember) return { color: null, intensity: 0, outline: true };
    if (hovered || isPortHovered) return { color: null, intensity: 0, outline: true };
    return { color: null, intensity: 0, outline: false };
  }, [isSelected, isGroupMember, isBlocked, pulse, hovered, isPortHovered]);

  const interactionPhase = useStore(s => s.interactionPhase);
  const selectedPort = useStore(s => s.selectedPort);
  const activeMeshUrl = useMemo(() => encodeModelUrl(ldrawPart.meshUrl), [ldrawPart.meshUrl]);

  if (ldrawPart.loading) return null;

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  const isRenderingActive = hovered || isPortHovered || isSelected || isStatic;
  const finalOpacity = isRenderingActive ? (opacity < 1 ? opacity : 0.5) : 1.0;
  const finalShowPorts = showPorts && isRenderingActive;

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

      {finalShowPorts && ldrawPart.sites?.map((site) => (
        <SiteGizmo
          key={site.id}
          site={site}
          groupRef={groupRef as React.RefObject<THREE.Group>}
          partId={partId}
          ldrawId={ldrawId || partId}
          phase={interactionPhase}
          sourcePortType={selectedPort?.portType ?? null}
          selectedPort={selectedPort}
          onPortClick={onPortClick}
          onPortHover={handlePortHoverLocal}
        />
      ))}
    </group>
  );
});

InteractivePart.displayName = 'InteractivePart';

import { memo, useMemo, useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../store';
import { SelectionLevel, InteractionPhase, SelectedPortInfo } from '../types';
import { useLDrawPart } from '../useLDrawPart';
import { LDrawMeshRenderer } from './LDrawMeshRenderer';
import { SiteGizmo } from './SiteGizmo';
import { RenderErrorBoundary } from './RenderErrorBoundary';
import { AutoFitCamera } from './AutoFitCamera';

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
  opacity?: number;
  autoCenter?: boolean;
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
  opacity = 1.0,
  autoCenter = false
}: InteractivePartProps) => {
  const [hovered, setHover] = useState(false);
  const selection = useStore(s => s.selection);
  const interference = useStore(s => s.interferenceReport);
  
  const isSelected = selection.primaryId === partId;
  const isGroupMember = selection.level === SelectionLevel.GROUP && selection.allConnectedIds.includes(partId);
  const isBlocked = isSelected && interference.isBlocked;

  const [pulse, setPulse] = useState(0);
  const currentPhase = useStore(s => s.interactionPhase);
  const slidingTarget = useStore(s => s.slidingTarget);
  const updateSlideOffset = useStore(s => s.updateSlideOffset);
  const commitAxialSliding = useStore(s => s.commitAxialSliding);
  const { mouse, raycaster, camera } = useThree();

  // --- 沿轴滑动 (Axial Sliding) 全局手势处理 ---
  useEffect(() => {
    if (currentPhase !== InteractionPhase.AXIAL_SLIDING || !isSelected || !slidingTarget) return;

    const handlePointerMove = () => {
      // 1. 定义滑动轴线 (Z-axis in world space)
      const targetPos = new THREE.Vector3(...slidingTarget.globalPos);
      const targetQuat = new THREE.Quaternion(...slidingTarget.globalQuat);
      const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(targetQuat).normalize();

      // 2. 获取射线与轴线的最近点
      // 构造轴线射线
      const axisRay = new THREE.Ray(targetPos, axis);
      raycaster.setFromCamera(mouse, camera);
      const mouseRay = raycaster.ray;

      // 计算两条无限长直线的公垂线基点。这里我们寻找 mouseRay 上最接近 axisRay 的点，
      // 然后投影到 axisRay 上。
      const closestPointOnAxis = new THREE.Vector3();
      const closestPointOnMouseRay = new THREE.Vector3();
      
      // 使用 THREE.Ray.distanceSqToRay 或类似的几何方法
      // 简便方法：求解两条射线的最短距离点
      // @ts-expect-error extended math function
      const distSq = mouseRay.distanceSqToRay(axisRay, closestPointOnMouseRay, closestPointOnAxis);
      
      // 3. 计算位移值 (点与原点的带符号投影距离)
      const diff = new THREE.Vector3().subVectors(closestPointOnAxis, targetPos);
      const offset = diff.dot(axis);
      
      // 4. 应用物理限位 (MVP: +/- 0.5 stud)
      const CLAMP_LIMIT = 20 * LDU; // 一个完整格
      const clampedOffset = Math.max(-CLAMP_LIMIT, Math.min(CLAMP_LIMIT, offset));
      
      updateSlideOffset(clampedOffset);
    };

    const handlePointerUp = () => {
      commitAxialSliding();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [currentPhase, isSelected, slidingTarget, raycaster, mouse, camera, updateSlideOffset, commitAxialSliding]);

  useFrame(({ clock, raycaster }) => {
    // Pulse 动画（干涉状态）
    if (isBlocked) {
      setPulse(Math.sin(clock.elapsedTime * 12) * 0.4 + 0.6);
    } else if (pulse !== 0) {
      setPulse(0);
    }

    // 逐帧射线检测 Hover 状态：
    // 使用 R3F 当前帧的 raycaster（已由 R3F 更新到当前鼠标位置）直接对 group 做检测。
    // 比事件系统更可靠：
    //   - 无子网格切换"空窗"导致的虚假 onPointerLeave
    //   - 无 stopPropagation / 事件冒泡链的复杂性
    //   - 精度到三角面级别，无包围球近似误差
    if (!isStatic && groupRef.current) {
      const hits = raycaster.intersectObject(groupRef.current, true);
      const isNowHovered = hits.length > 0;
      if (isNowHovered !== hoveredRef.current) {
        hoveredRef.current = isNowHovered;
        setHover(isNowHovered);
        onHoverChange?.(isNowHovered);
      }
    }
  });

  const highlight = useMemo(() => {
    if (isBlocked) return { color: '#ff3d00', intensity: pulse };
    if (isSelected) return { color: '#2979ff', intensity: 0.8 };
    if (isGroupMember) return { color: '#2979ff', intensity: 0.25 };
    if (hovered) return { color: '#ffffff', intensity: 0.15 };
    return { color: null, intensity: 0 };
  }, [isSelected, isGroupMember, isBlocked, pulse, hovered]);

  const [forceFallback, setForceFallback] = useState(false);
  const ldrawPart = useLDrawPart(ldrawId || partId, colorCode);
  const groupRef = useRef<THREE.Group>(null);
  // 用 ref 追踪上一帧的 hover 结果，避免每帧不必要地触发 setState
  const hoveredRef = useRef(false);

  // 宏观考量：如果元数据层面报错，直接标记强制降级
  const isDataError = !!ldrawPart.error;
  const shouldRenderMesh = !!ldrawPart.meshUrl && !isDataError && !forceFallback;

  const interactionPhase = useStore(s => s.interactionPhase);
  const selectedPort = useStore(s => s.selectedPort);



  const activeMeshUrl = useMemo(() => encodeModelUrl(ldrawPart.meshUrl), [ldrawPart.meshUrl]);

  if (ldrawPart.loading) return null;

  const isRenderingActive = hovered || isSelected || isStatic;
  const finalOpacity = isRenderingActive ? (opacity < 1 ? opacity : 0.5) : 1.0;
  const finalShowPorts = showPorts && isRenderingActive;

  return (
    <group ref={groupRef}>
      {/* 集中处理自适应对焦，仅在明确指定且网格有效时激活 */}
      <AutoFitCamera targetRef={groupRef} enabled={autoCenter && shouldRenderMesh} />

      {shouldRenderMesh && activeMeshUrl ? (
        <RenderErrorBoundary 
            onCatch={() => setForceFallback(true)}
        >
            <LDrawMeshRenderer
              url={activeMeshUrl}
              onDoubleClick={onDoubleClick}
              highlightColor={highlight.color}
              highlightIntensity={highlight.intensity}
              opacity={finalOpacity}
            />
        </RenderErrorBoundary>
      ) : (
        <mesh
          onDoubleClick={onDoubleClick}
        >
          {/* 红色警告表示加载彻底失败，灰色表示仅数据拉取中或正常占位 */}
          <boxGeometry args={[10 * LDU, 10 * LDU, 10 * LDU]} />
          <meshStandardMaterial 
            color={forceFallback || isDataError ? '#ff5252' : (highlight.color || (hovered ? '#ff9800' : '#b0bec5'))} 
            emissive={forceFallback || isDataError ? '#b71c1c' : '#000000'}
            emissiveIntensity={forceFallback || isDataError ? pulse : 0}
            transparent={finalOpacity < 1}
            opacity={finalOpacity}
          />
        </mesh>
      )}

      {/* Site-based Gizmo 渲染（新交互）：完全依赖后端的 v3.1 Site 聚类数据进行方向推理 */}
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
          onPortHover={onPortHover}
        />
      ))}
    </group>
  );
});

InteractivePart.displayName = 'InteractivePart';

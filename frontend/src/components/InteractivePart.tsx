import { memo, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store';
import { SelectionLevel } from '../types';
import { useLDrawPart } from '../useLDrawPart';
import { LDrawMeshRenderer } from './LDrawMeshRenderer';

import { RenderErrorBoundary } from './RenderErrorBoundary';

const BACKEND_ORIGIN = (import.meta as any).env.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:8000';

const encodeModelUrl = (path: string | undefined) => {
  if (!path) return null;
  return encodeURI(`${BACKEND_ORIGIN}${path}`);
};

const LDU = 0.0004;

interface InteractivePartProps {
  partId: string;
  ldrawId?: string;
  colorCode?: number;
  onPortClick?: (port: any) => void;
  onPortHover?: (port: any | null) => void;
  showPorts?: boolean;
  onHoverChange?: (h: boolean) => void;
  onDoubleClick?: () => void;
  isStatic?: boolean;
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
  isStatic = false 
}: InteractivePartProps) => {
  const [hovered, setHover] = useState(false);
  const selection = useStore(s => s.selection);
  const interference = useStore(s => s.interferenceReport);
  
  const isSelected = selection.primaryId === partId;
  const isGroupMember = selection.level === SelectionLevel.GROUP && selection.allConnectedIds.includes(partId);
  const isBlocked = isSelected && interference.isBlocked;

  const [pulse, setPulse] = useState(0);
  useFrame(({ clock }) => {
    if (isBlocked) {
      setPulse(Math.sin(clock.elapsedTime * 12) * 0.4 + 0.6);
    } else if (pulse !== 0) {
      setPulse(0);
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

  // 宏观考量：如果元数据层面报错，直接标记强制降级
  const isDataError = !!ldrawPart.error;
  const shouldRenderMesh = !!ldrawPart.meshUrl && !isDataError && !forceFallback;

  const effectivePorts = useMemo(() => {
    const computeQuaternion = (r: number[][]) => {
      const mat = new THREE.Matrix4().set(
        r[0][0], r[0][1], r[0][2], 0,
        r[1][0], r[1][1], r[1][2], 0,
        r[2][0], r[2][1], r[2][2], 0,
        0, 0, 0, 1
      );
      return new THREE.Quaternion().setFromRotationMatrix(mat);
    };

    if (ldrawPart.ports && ldrawPart.ports.length > 0) {
      return ldrawPart.ports.map((p) => {
        // 宏观兼容性治理：
        // 如果后端传来的坐标已经转换成了米（数值通常在 0.x 级别），
        const rawPos = p.position as [number, number, number];
        
        // 核心修正：由于后端的 GLB 导出器已经执行了 0.0004 的米制缩放，
        // 前端渲染层必须直接使用米制原始坐标，严禁再次除以 LDU 导致坐标逃逸。
        const normalizedPos = rawPos; 
        
        return {
          type: p.type && p.type.toLowerCase().includes('hole') ? 'peghole' : 'peg',
          localPos: normalizedPos,
          rot: p.rotation,
          quaternion: computeQuaternion(p.rotation)
        };
      });
    }
    return [];
  }, [ldrawPart.ports]);

  const activeMeshUrl = useMemo(() => encodeModelUrl(ldrawPart.meshUrl), [ldrawPart.meshUrl]);

  if (ldrawPart.loading) return null;

  const handlePointerOver = (e: any) => {
    e.stopPropagation();
    setHover(true);
    onHoverChange?.(true);
  };

  const handlePointerOut = () => {
    setHover(false);
    onHoverChange?.(false);
  };

  return (
    <group ref={groupRef}>
      {shouldRenderMesh && activeMeshUrl ? (
        <RenderErrorBoundary 
            onCatch={() => setForceFallback(true)}
        >
            <LDrawMeshRenderer
              url={activeMeshUrl}
              onPointerOver={handlePointerOver}
              onPointerOut={handlePointerOut}
              onDoubleClick={onDoubleClick}
              highlightColor={highlight.color}
              highlightIntensity={highlight.intensity}
            />
        </RenderErrorBoundary>
      ) : (
        <mesh
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          onDoubleClick={onDoubleClick}
        >
          {/* 红色警告表示加载彻底失败，灰色表示仅数据拉取中或正常占位 */}
          <boxGeometry args={[10 * LDU, 10 * LDU, 10 * LDU]} />
          <meshStandardMaterial 
            color={forceFallback || isDataError ? '#ff5252' : (highlight.color || (hovered ? '#ff9800' : '#b0bec5'))} 
            emissive={forceFallback || isDataError ? '#b71c1c' : '#000000'}
            emissiveIntensity={forceFallback || isDataError ? pulse : 0}
          />
        </mesh>
      )}

      {showPorts && effectivePorts.map((port, idx) => {
        const isHole = port.type === 'peghole';
        const color = isHole ? '#2196f3' : '#e040fb';

        return (
          <group key={idx} position={port.localPos} quaternion={port.quaternion}>
            <mesh>
              <sphereGeometry args={[4 * LDU, 12, 12]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={0.85}
                depthTest={false}
              />
            </mesh>
            <mesh position={[0, 0, 3 * LDU]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.5 * LDU, 0.5 * LDU, 6 * LDU, 8]} />
              <meshBasicMaterial color={color} transparent opacity={0.85} depthTest={false} />
            </mesh>
            <mesh position={[0, 0, 8 * LDU]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[2 * LDU, 4 * LDU, 8]} />
              <meshBasicMaterial color={color} transparent opacity={0.85} depthTest={false} />
            </mesh>

            <mesh
              renderOrder={999}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = 'pointer';
                const worldPos = new THREE.Vector3().copy(new THREE.Vector3(...port.localPos));
                const worldQuat = new THREE.Quaternion().copy(port.quaternion);
                if (groupRef.current) {
                    groupRef.current.localToWorld(worldPos);
                    const groupWorldQuat = new THREE.Quaternion();
                    groupRef.current.getWorldQuaternion(groupWorldQuat);
                    worldQuat.premultiply(groupWorldQuat);
                }
                
                onPortHover?.({
                  partId,
                  ldrawId: ldrawId || partId,
                  portType: port.type,
                  position: port.localPos,
                  rotation: port.rot,
                  globalPos: [worldPos.x, worldPos.y, worldPos.z],
                  globalQuat: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
                });
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto';
                onPortHover?.(null);
              }}
              onClick={(e) => {
                e.stopPropagation();
                const worldPos = new THREE.Vector3().copy(new THREE.Vector3(...port.localPos));
                const worldQuat = new THREE.Quaternion().copy(port.quaternion);
                
                if (groupRef.current) {
                    groupRef.current.localToWorld(worldPos);
                    const groupWorldQuat = new THREE.Quaternion();
                    groupRef.current.getWorldQuaternion(groupWorldQuat);
                    worldQuat.premultiply(groupWorldQuat);
                }
                
                onPortClick?.({
                  partId,
                  ldrawId: ldrawId || partId,
                  portType: port.type,
                  position: port.localPos,
                  rotation: port.rot,
                  globalPos: [worldPos.x, worldPos.y, worldPos.z],
                  globalQuat: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
                });
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <sphereGeometry args={[12 * LDU, 6, 6]} />
              <meshBasicMaterial transparent opacity={0} depthTest={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
});

InteractivePart.displayName = 'InteractivePart';

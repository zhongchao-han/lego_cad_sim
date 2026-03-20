import { memo, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useLDrawPart } from '../useLDrawPart';
import { LDrawMeshRenderer } from './LDrawMeshRenderer';
import PropTypes from 'prop-types';

const BACKEND_ORIGIN = import.meta.env.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:8000';
const LDU = 0.0004;

export const InteractivePart = memo(({ 
  partId,
  ldrawId, // 实际对应的 LDraw 资源 ID
  colorCode = 7, 
  onPortClick, 
  showPorts = true, 
  onHoverChange,
  onDoubleClick,
  isStatic = false 
}: any) => {
  const [hovered, setHover] = useState(false);
  const ldrawPart = useLDrawPart(ldrawId || partId, colorCode);
  const groupRef = useRef<THREE.Group>(null);

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
      return ldrawPart.ports.map((p) => ({
        type: p.type && p.type.toLowerCase().includes('hole') ? 'peghole' : 'peg',
        localPos: p.position,
        rot: p.rotation,
        quaternion: computeQuaternion(p.rotation)
      }));
    }
    return [];
  }, [ldrawPart.ports]);

  const activeMeshUrl = ldrawPart.meshUrl ? `${BACKEND_ORIGIN}${ldrawPart.meshUrl}` : null;

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
      {activeMeshUrl ? (
        <LDrawMeshRenderer
          url={activeMeshUrl}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          onDoubleClick={onDoubleClick}
        />
      ) : (
        <mesh
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          onDoubleClick={onDoubleClick}
        >
          <boxGeometry args={[0.005, 0.005, 0.005]} />
          <meshBasicMaterial color={hovered ? '#ff9800' : '#b0bec5'} />
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
            {/* 箭杆：指示插入方向 (局部 Z 轴) */}
            <mesh position={[0, 0, 3 * LDU]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.5 * LDU, 0.5 * LDU, 6 * LDU, 8]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={0.85}
                depthTest={false}
              />
            </mesh>
            {/* 箭头 */}
            <mesh position={[0, 0, 8 * LDU]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[2 * LDU, 4 * LDU, 8]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={0.85}
                depthTest={false}
              />
            </mesh>

            <mesh
              renderOrder={999}
              onClick={(e) => {
                e.stopPropagation();
                // 如果是静态零件（如预览窗内），不需要计算世界坐标
                const worldPos = new THREE.Vector3(...port.localPos);
                if (!isStatic && groupRef.current) {
                   groupRef.current.localToWorld(worldPos);
                }
                
                onPortClick?.({
                  partId, // 实例 ID
                  ldrawId: ldrawId || partId, // 材质 ID
                  portType: port.type,
                  position: port.localPos,
                  rotation: port.rot,
                  globalPos: [worldPos.x, worldPos.y, worldPos.z],
                });
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = 'pointer';
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto';
              }}
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
InteractivePart.propTypes = {
  partId: PropTypes.string.isRequired,
  colorCode: PropTypes.number,
  onPortClick: PropTypes.func,
  showPorts: PropTypes.bool,
  onHoverChange: PropTypes.func,
  onDoubleClick: PropTypes.func,
  isStatic: PropTypes.bool,
};

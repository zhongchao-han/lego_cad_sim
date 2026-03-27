import React, { useMemo, useState } from 'react';
import * as THREE from 'three';

const LDU = 0.0004;

interface PortVisualizerProps {
  type: string;
  gender?: string;
  position: [number, number, number];
  rotation: number[][];
  isSelected?: boolean;
  onSelect?: () => void;
}

export const PortVisualizer: React.FC<PortVisualizerProps> = ({
  type,
  gender,
  position,
  rotation,
  isSelected,
  onSelect
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const isFemale = gender ? gender === 'FEMALE' : (type.toLowerCase().includes('hole') || type.toLowerCase().includes('hol') || type === 'peghole' || type === 'axlehole');
  const color = isFemale ? '#3b82f6' : '#a855f7';
  const displayColor = isHovered ? '#ffffff' : color;
  
  const matrix = useMemo(() => {
    const m = new THREE.Matrix4();
    if (rotation && rotation.length === 3) {
      m.set(
        rotation[0][0], rotation[0][1], rotation[0][2], 0,
        rotation[1][0], rotation[1][1], rotation[1][2], 0,
        rotation[2][0], rotation[2][1], rotation[2][2], 0,
        0, 0, 0, 1
      );
    }
    return m;
  }, [rotation]);

  const direction = useMemo(() => {
    const dir = new THREE.Vector3(0, 0, 1);
    dir.applyMatrix4(matrix);
    return dir.normalize();
  }, [matrix]);

  const xDirection = useMemo(() => {
    const dir = new THREE.Vector3(1, 0, 0);
    dir.applyMatrix4(matrix);
    return dir.normalize();
  }, [matrix]);

  const posVec = useMemo(() => {
    return new THREE.Vector3(
      position[0] * LDU,
      position[1] * LDU,
      position[2] * LDU
    );
  }, [position]);

  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromRotationMatrix(matrix);
    return q;
  }, [matrix]);

  return (
    <group position={posVec}>
      {/* 主轴：Z 轴 (插入方向) */}
      <arrowHelper 
        args={[direction, new THREE.Vector3(0, 0, 0), 12 * LDU, displayColor, 4 * LDU, 2 * LDU]} 
      />
      {/* 辅助轴：X 轴 (用于观察绕 Z 轴的旋转) */}
      {isSelected && (
        <arrowHelper 
          args={[xDirection, new THREE.Vector3(0, 0, 0), 8 * LDU, "#ff3e3e", 2 * LDU, 1 * LDU]} 
        />
      )}
      <mesh>

        <sphereGeometry args={[isSelected ? 6 * LDU : 5 * LDU, 16, 16]} />
        <meshBasicMaterial color={displayColor} transparent opacity={isSelected ? 0.8 : (isHovered ? 0.7 : 0.5)} />
      </mesh>
      {isSelected && (
        <mesh>
          <sphereGeometry args={[0.0035, 16, 16]} />
          <meshBasicMaterial color="white" wireframe />
        </mesh>
      )}
      {/* 具有方向性的交互热区：沿着 Z 轴（插拔方向）延伸的不可见圆柱体 */}
      <group quaternion={quaternion}>
        {/* 圆柱体默认沿 Y 轴，将其旋转到与 Z 轴平行，并沿 Z 轴正向偏移半个身位以避免反向重叠 */}
        <mesh 
          position={[0, 0, 8 * LDU]} 
          rotation={[Math.PI / 2, 0, 0]} 
          onClick={(e) => { 
            console.debug('[PortVisualizer] 端口射线检测命中，触发精确点击', { type, gender, isFemale, position });
            e.stopPropagation(); 
            onSelect?.(); 
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setIsHovered(true);
          }}
          onPointerOut={(e) => {
            e.stopPropagation();
            setIsHovered(false);
          }}
        >
          <cylinderGeometry args={[10 * LDU, 10 * LDU, 16 * LDU, 16]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
};

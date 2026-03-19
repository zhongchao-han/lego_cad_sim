import React, { useMemo } from 'react';
import * as THREE from 'three';

const LDU = 0.0004;

interface PortVisualizerProps {
  type: string;
  position: [number, number, number];
  rotation: number[][];
  isSelected?: boolean;
  onSelect?: () => void;
}

export const PortVisualizer: React.FC<PortVisualizerProps> = ({
  type,
  position,
  rotation,
  isSelected,
  onSelect
}) => {
  const isFemale = type.toLowerCase().includes('hole');
  const color = isFemale ? '#3b82f6' : '#a855f7';
  
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

  const posVec = useMemo(() => {
    return new THREE.Vector3(
      position[0] * LDU,
      position[1] * LDU,
      position[2] * LDU
    );
  }, [position]);

  return (
    <group position={posVec}>
      <arrowHelper 
        args={[direction, new THREE.Vector3(0, 0, 0), 0.015, color, 0.005, 0.003]} 
      />
      <mesh>
        <sphereGeometry args={[isSelected ? 0.003 : 0.002, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={isSelected ? 0.8 : 0.5} />
      </mesh>
      {isSelected && (
        <mesh>
          <sphereGeometry args={[0.0035, 16, 16]} />
          <meshBasicMaterial color="white" wireframe />
        </mesh>
      )}
      {/* 增大交互热区：一个透明的球体负责点击事件 */}
      <mesh onClick={(e) => { e.stopPropagation(); onSelect?.(); }}>
        <sphereGeometry args={[0.006, 16, 16]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
};

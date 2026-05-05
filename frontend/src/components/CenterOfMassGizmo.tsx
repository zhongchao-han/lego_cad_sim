/**
 * CenterOfMassGizmo — L51 整体质心可视化
 * ========================================
 * 在场景的整体质心位置画一个标记：
 *   - 稳定（COM 投影 ∈ footprint）→ 绿色十字 + 中心球
 *   - 不稳定 → 红色十字 + 中心球（更醒目示警）
 *
 * 仅 ASSEMBLY 模式 + 至少 1 个 ACTIVE_ARENA part 时由 Scene.jsx 挂入。
 * 几何尺寸用 LDU 量级（4 LDU = 1.6mm），与零件本身视觉占比相称。
 */
import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '../types';

const LDU_M = 0.0004;
const ARM_LENGTH = 4 * LDU_M; // 1.6mm
const ARM_THICKNESS = 0.3 * LDU_M; // 0.12mm
const SPHERE_RADIUS = 1.2 * LDU_M; // 0.48mm

interface Props {
  position: Vec3;
  isStable: boolean;
}

export const CenterOfMassGizmo = React.memo(function CenterOfMassGizmo({
  position,
  isStable,
}: Props) {
  const color = isStable ? '#22c55e' /* green-500 */ : '#ef4444' /* red-500 */;
  const emissive = isStable ? '#16a34a' : '#dc2626';

  // 三个互垂直的扁长 box 形成"十字 / 三轴标"
  const arms = useMemo(() => {
    const xArm = new THREE.BoxGeometry(ARM_LENGTH, ARM_THICKNESS, ARM_THICKNESS);
    const yArm = new THREE.BoxGeometry(ARM_THICKNESS, ARM_LENGTH, ARM_THICKNESS);
    const zArm = new THREE.BoxGeometry(ARM_THICKNESS, ARM_THICKNESS, ARM_LENGTH);
    return { xArm, yArm, zArm };
  }, []);

  return (
    <group position={position}>
      {/* 中心球 */}
      <mesh raycast={() => null}>
        <sphereGeometry args={[SPHERE_RADIUS, 16, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={isStable ? 0.4 : 0.7}
        />
      </mesh>
      {/* 三轴 */}
      <mesh geometry={arms.xArm} raycast={() => null}>
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
      </mesh>
      <mesh geometry={arms.yArm} raycast={() => null}>
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
      </mesh>
      <mesh geometry={arms.zArm} raycast={() => null}>
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.3} />
      </mesh>
    </group>
  );
});

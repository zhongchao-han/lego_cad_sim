/**
 * ReactionForceVisualizer — L51b PR-B 反力可视化
 * ================================================
 * 在每条 ConnectionEdge 的 wrench 作用点 (anchor_world) 画一支箭头：
 *   - 起点：anchor_world
 *   - 方向：force 单位向量
 *   - 长度：固定缩放（防 magnitude 极大时贯穿全场景）
 *   - 颜色：HSV 色环 by magnitude（绿低 → 黄中 → 红高）
 *
 * 视觉负载小：每条 edge 一支细长 arrow + 一个小球（拍点）。
 * 仅 store.showReactionForces=true 时挂入；toolbar / StatusBar 切换。
 *
 * 数据流：store.reactionForces 由 refreshReactionForces() 异步拉。
 * 上游触发：Scene.jsx 的 useEffect 监听 connections / showReactionForces。
 */
import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../store';
import type { Vec3 } from '../types';

const ARROW_LENGTH_M = 0.012; // 12mm，约 30 LDU 量级，肉眼可见但不夸张
const ARROW_SHAFT_RADIUS_M = 0.0008;
const ARROW_HEAD_HEIGHT_M = 0.003;
const ARROW_HEAD_RADIUS_M = 0.0018;
const ANCHOR_BALL_RADIUS_M = 0.0008;

/** magnitude (N) → 颜色。0 N=纯绿(120°)；100 N=纯红(0°)。clamp 之外按端点色。 */
function magnitudeToColor(mag: number): THREE.Color {
  const c = new THREE.Color();
  // log scale 让小值之间也有梯度感
  const t = Math.max(0, Math.min(1, Math.log10(mag + 1) / 2)); // log(101)/2 ≈ 1
  const hue = (1 - t) * 120; // 120° 绿 → 0° 红
  c.setHSL(hue / 360, 1.0, 0.55);
  return c;
}

const _UNIT_Y = new THREE.Vector3(0, 1, 0);

interface ArrowMeshProps {
  anchor: Vec3;
  force:  Vec3;
  magnitude: number;
}

const SingleArrow = React.memo(function SingleArrow({
  anchor, force, magnitude,
}: ArrowMeshProps) {
  const geometry = useMemo(() => {
    // 箭头朝 force 单位向量方向；用 quaternion 把局部 +Y 转到 force_dir
    const dir = new THREE.Vector3(force[0], force[1], force[2]);
    if (dir.lengthSq() < 1e-12) return null;
    dir.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(_UNIT_Y, dir);
    return q;
  }, [force]);

  if (!geometry) return null;

  const color = magnitudeToColor(magnitude);

  return (
    <group position={anchor}>
      {/* 锚点小球 */}
      <mesh raycast={() => null}>
        <sphereGeometry args={[ANCHOR_BALL_RADIUS_M, 8, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
      {/* 箭头杆（沿 +Y）+ 头 */}
      <group quaternion={geometry}>
        <mesh
          position={[0, ARROW_LENGTH_M / 2, 0]}
          raycast={() => null}
        >
          <cylinderGeometry args={[ARROW_SHAFT_RADIUS_M, ARROW_SHAFT_RADIUS_M, ARROW_LENGTH_M, 6]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
        </mesh>
        <mesh
          position={[0, ARROW_LENGTH_M + ARROW_HEAD_HEIGHT_M / 2, 0]}
          raycast={() => null}
        >
          <coneGeometry args={[ARROW_HEAD_RADIUS_M, ARROW_HEAD_HEIGHT_M, 8]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} />
        </mesh>
      </group>
    </group>
  );
});

export function ReactionForceVisualizer() {
  const enabled = useStore(s => s.showReactionForces);
  const reactions = useStore(s => s.reactionForces);
  if (!enabled) return null;
  return (
    <>
      {Object.entries(reactions).map(([key, r]) => (
        <SingleArrow
          key={key}
          anchor={r.anchorWorld}
          force={r.force}
          magnitude={r.magnitudeForce}
        />
      ))}
    </>
  );
}

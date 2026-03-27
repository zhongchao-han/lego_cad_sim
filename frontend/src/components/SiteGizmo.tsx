/**
 * SiteGizmo.tsx
 * =============
 * 基于 Site 聚类的 3D 方向选择 Gizmo 组件。
 *
 * 交互阶段行为：
 *   IDLE / PREVIEWING   : 显示小中性球（存在感提示），不展开箭头。
 *   Hover（任意阶段）    : 展开该 Site 内所有 Port 的方向箭头。
 *   SOURCE_LOCKED        : 仅展开与手持源端口兼容的方向（Intent 过滤）。
 *   点击箭头             : 调用 onPortClick 传递所选端口信息。
 *
 * 颜色规范（与 UI 文档对齐）：
 *   - 紫色 (#e040fb) : MALE 端口（销/轴）
 *   - 蓝色 (#2196f3) : FEMALE 端口（孔）
 *   - 橙色 (#ff9800) : Hover/Selected 激活态（覆盖极性色）
 */

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LDrawSite, LDrawPort } from '../useLDrawPart';
import type { Vec3, Mat3, SelectedPortInfo } from '../types';
import { InteractionPhase } from '../types';

const LDU = 0.0004;

// ─── 常量 ──────────────────────────────────────────────────────────────────

const IDLE_SPHERE_RADIUS = 2.5 * LDU;   // 静默态：小点提示（备用）
const ARROW_LENGTH       = 24 * LDU;    // 展开态：箭头总长（根据要求放大）
const ARROW_HEAD_LEN     = 8 * LDU;     // 箭头头部长度
const ARROW_HEAD_WIDTH   = 4.5 * LDU;   // 箭头头部宽度
const GIZMO_SPHERE_R     = 5 * LDU;     // 展开态：方向箭头根部球（稍微放大）

// ─── 类型辅助 ──────────────────────────────────────────────────────────────

function isFemale(port: LDrawPort): boolean {
  if (port.gender) {
    return port.gender === 'FEMALE';
  }
  const t = port.type?.toLowerCase() || '';
  return t.includes('hole') || t.includes('hol') || t === 'peghole' || t === 'axlehole';
}

function isCompatible(sourcePortType: string | null, targetPort: LDrawPort): boolean {
  if (!sourcePortType) return true; // SOURCE_LOCKED 未设置时，全部显示
  
  const srcIsFemale = sourcePortType.toLowerCase().includes('hole') || sourcePortType.toLowerCase().includes('hol');
  const tgtIsFemale = isFemale(targetPort);
  
  // 简单极性过滤：一孔一插才算兼容
  return srcIsFemale !== tgtIsFemale;
}

function computePortQuaternion(rotation: number[][]): THREE.Quaternion {
  const mat = new THREE.Matrix4().set(
    rotation[0][0], rotation[0][1], rotation[0][2], 0,
    rotation[1][0], rotation[1][1], rotation[1][2], 0,
    rotation[2][0], rotation[2][1], rotation[2][2], 0,
    0, 0, 0, 1
  );
  return new THREE.Quaternion().setFromRotationMatrix(mat);
}

// ─── 子组件：单箭头 ────────────────────────────────────────────────────────

interface PortArrowProps {
  port: LDrawPort;
  /** Site 中心相对于零件的局部坐标（用于推算箭头的渲染偏移位置） */
  sitePos: Vec3;
  isSelected: boolean;
  isCompatiblePort: boolean;
  groupRef: React.RefObject<THREE.Group>;
  partId: string;
  ldrawId: string;
  onPortClick?: (info: SelectedPortInfo) => void;
  onPortHover?: (info: SelectedPortInfo | null) => void;
}

function PortArrow({
  port, sitePos, isSelected, isCompatiblePort, groupRef, partId, ldrawId, onPortClick, onPortHover
}: PortArrowProps) {
  const [hovered, setHovered] = useState(false);

  const genderColor = isFemale(port) ? '#2196f3' : '#e040fb';
  // 默认态：当仅仅是零件被 hover 时，端口和箭头显示为灰色
  let color = '#888888';
  let opacity = 0.5;
  
  // 激活态：当精确 hover 到这个特定箭头，或者被选中时，高亮显示
  if (hovered || isSelected) {
    color = genderColor;
    opacity = 0.9;
  }
  
  // 不兼容的源端口过滤（变暗）
  if (!isCompatiblePort) {
    color = '#444444';
    opacity = 0.2;
  }

  // pos: 端口在「零件局部坐标系」中的原始坐标
  // 这是给 buildPortInfo 使用的物理锚点，必须保持为零件局部值，不能被 Site 偏移污染
  const pos = port.position as Vec3;

  // renderPos: 端口在「站点（Site）局部坐标系」中的渲染偏移
  // 由于 <group> 已经 position={sitePos}，箭头位置需要再减去 sitePos 才能定位到正确位置
  const renderPos = useMemo((): Vec3 => [
    pos[0] - sitePos[0],
    pos[1] - sitePos[1],
    pos[2] - sitePos[2],
  ], [pos, sitePos]);

  const quaternion = useMemo(() => computePortQuaternion(port.rotation), [port.rotation]);

  const buildPortInfo = useCallback((): SelectedPortInfo => {
    // 必须用 pos（零件坐标系原点出发），确保 localToWorld 变换后得到正确的世界坐标
    const worldPos = new THREE.Vector3(...pos);
    const worldQuat = new THREE.Quaternion().copy(quaternion);
    if (groupRef.current) {
      groupRef.current.localToWorld(worldPos);
      const gq = new THREE.Quaternion();
      groupRef.current.getWorldQuaternion(gq);
      worldQuat.premultiply(gq);
    }
    return {
      partId, ldrawId,
      portType: port.type,
      position: pos,           // 零件局部坐标，供 Snap 数学计算
      rotation: port.rotation as Mat3,
      globalPos: [worldPos.x, worldPos.y, worldPos.z],
      globalQuat: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
    };
  }, [pos, quaternion, groupRef, partId, ldrawId, port]);

  // Z 轴方向向量（端口的插入法向）
  const direction = useMemo(() => {
    const zAxis = new THREE.Vector3(
      port.rotation[0][2], port.rotation[1][2], port.rotation[2][2]
    ).normalize();
    return zAxis;
  }, [port.rotation]);

  // 防御性光标清理，避免组件因父级状态切换突然卸载时导致样式残留
  useEffect(() => {
    return () => {
      if (hovered) {
        document.body.style.cursor = 'auto';
      }
    };
  }, [hovered]);

  return (
    // 使用 renderPos（站点局部偏移）定位箭头，保证视觉准确
    <group position={renderPos}>
      {/* 方向箭头：由于 LDU 极小比例，内部的 THREE.Line 默认距离阈值为 1，会引发惊人的全屏误触！必须强行关闭其物理碰撞 */}
      <arrowHelper
        args={[
          direction,
          new THREE.Vector3(0, 0, 0),
          ARROW_LENGTH, color, ARROW_HEAD_LEN, ARROW_HEAD_WIDTH
        ]}
        onUpdate={(self) => {
          self.traverse((child) => {
            child.raycast = () => {}; 
          });
        }}
      />
      {/* 根部球体（视觉锚点） */}
      <mesh quaternion={quaternion}>
        <sphereGeometry args={[GIZMO_SPHERE_R, 10, 10]} />
        <meshBasicMaterial color={color} toneMapped={false} opacity={opacity} transparent />
      </mesh>
      {/* 独立封装的完美方向性碰撞热区 (Directional Hitbox) */}
      <group>
        <mesh
          position={new THREE.Vector3().copy(direction).multiplyScalar(ARROW_LENGTH / 2)}
          quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)}
          renderOrder={999}
          onPointerOver={(e) => {
            e.stopPropagation();
            document.body.style.cursor = 'pointer';
            setHovered(true);
            onPortHover?.(buildPortInfo());
          }}
          onPointerOut={(e) => {
            e.stopPropagation();
            document.body.style.cursor = 'auto';
            setHovered(false);
            onPortHover?.(null);
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            console.debug('[SiteGizmo:PortArrow] 精确捕获点击目标', { port, isCompatiblePort });
            if (!isCompatiblePort) {
              console.debug('[SiteGizmo:PortArrow] 端口兼容性校验失败，丢弃点击事件');
              return;
            }
            onPortClick?.(buildPortInfo());
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {/* 热区圆柱体：半径放大以方便点击，长度覆盖整个箭头 */}
          <cylinderGeometry args={[10 * LDU, 10 * LDU, ARROW_LENGTH, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

// ─── 主组件：SiteGizmo ─────────────────────────────────────────────────────

export interface SiteGizmoProps {
  site: LDrawSite;
  groupRef: React.RefObject<THREE.Group>;
  partId: string;
  ldrawId: string;
  /** 当前 FSM 阶段（用于 Intent 过滤） */
  phase: InteractionPhase;
  /** SOURCE_LOCKED 时，手持的源端口类型（用于极性过滤） */
  sourcePortType?: string | null;
  /** 当前全局选中的端口信息，用于高亮 */
  selectedPort?: SelectedPortInfo | null;
  onPortClick?: (info: SelectedPortInfo) => void;
  onPortHover?: (info: SelectedPortInfo | null) => void;
}

export function SiteGizmo({
  site, groupRef, partId, ldrawId, phase, sourcePortType = null,
  selectedPort, onPortClick, onPortHover
}: SiteGizmoProps) {
  const sitePos = site.position as Vec3;

  return (
    <group position={sitePos}>
      {/* 始终渲染每个 Port 的方向箭头。颜色和事件由 PortArrow 独立代理封装控制 */}
      {site.ports.map((port, idx) => {
        const compatible = isCompatible(
          phase === InteractionPhase.SOURCE_LOCKED ? sourcePortType : null,
          port
        );

        // 判断当前端口是否已被选中
        const portPos = port.position as Vec3;
        const portIsSelected = !!selectedPort
          && selectedPort.partId === partId
          && Math.abs(selectedPort.position[0] - portPos[0]) < 1e-4
          && Math.abs(selectedPort.position[1] - portPos[1]) < 1e-4
          && Math.abs(selectedPort.position[2] - portPos[2]) < 1e-4;

        return (
          <PortArrow
            key={`${site.id}_port_${idx}`}
            port={port}         // 传递「零件局部坐标系」的原始端口数据，不做任何坐标变换
            sitePos={sitePos}   // 站点偏移由 PortArrow 内部处理，保持渲染与物理逻辑分离
            isSelected={portIsSelected}
            isCompatiblePort={compatible}
            groupRef={groupRef}
            partId={partId}
            ldrawId={ldrawId}
            onPortClick={onPortClick}
            onPortHover={onPortHover}
          />
        );
      })}
    </group>
  );
}

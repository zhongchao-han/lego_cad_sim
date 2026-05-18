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
 *   - 橙色 (#ff9800) : Source Locked 激活态（覆盖极性色）
 */

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LDrawSite, LDrawPort } from '../useLDrawPart';
import type { Vec3, Mat3, SelectedPortInfo } from '../types';
import { InteractionPhase, SelectionLevel } from '../types';
import { useStore, portKey } from '../store';

const LDU = 0.0004;

// ─── 常量 ──────────────────────────────────────────────────────────────────

const IDLE_SPHERE_RADIUS = 2.5 * LDU;   // 静默态：小点提示（备用）
const ARROW_LENGTH       = 24 * LDU;    // 展开态：箭头总长（根据要求放大）
const ARROW_HEAD_LEN     = 8 * LDU;     // 箭头头部长度
const ARROW_HEAD_WIDTH   = 4.5 * LDU;   // 箭头头部宽度
const GIZMO_SPHERE_R     = 5 * LDU;     // 展开态：方向箭头根部球（稍微放大）

// ─── 类型辅助 ──────────────────────────────────────────────────────────────

// `isFemale` / `isCompatible` 暴露出去仅为了让 __tests__/siteGizmo_compat.test.ts
// 可以直接做纯函数单测；运行时调用方仍然只在本文件内。改 SiteGizmo 极性规则时
// 单测先红、定位极快。
export function isFemale(port: LDrawPort): boolean {
  if (port.gender) {
    return port.gender === 'FEMALE';
  }
  const t = port.type?.toLowerCase() || '';
  return t.includes('hole') || t.includes('hol') || t === 'peghole' || t === 'axlehole';
}

/**
 * B.1：plug-sibling halo 触发条件（纯函数 — 让 siteGizmo_plug_halo.test.ts
 * 直接验，不走 React render）。
 *
 * 返 true 表示"该 port 应渲染暖黄 halo"：
 *   - 它有 plug_id（装饰类零件 / 老数据无 plug 直接跳过）
 *   - 有 port 在被 hover（store.hoveredPort 非空）
 *   - 那个 hovered port 跟本 port 在同一 part 实例 + 同一 plug
 *   - 本 port 不是被 hover 的那个本身（走常规 hover 视觉）
 *   - 本 port 也不是 selected（已经有 ACTIVE_COLOR 高亮）
 */
export function shouldHaloPlugSibling(args: {
  portPlugId: string | undefined;
  portPartId: string;
  hoveredPort: SelectedPortInfo | null;
  isThisPortHovered: boolean;
  isThisPortSelected: boolean;
}): boolean {
  const { portPlugId, portPartId, hoveredPort, isThisPortHovered, isThisPortSelected } = args;
  if (!portPlugId) return false;
  if (!hoveredPort || !hoveredPort.plug_id) return false;
  if (hoveredPort.partId !== portPartId) return false;
  if (hoveredPort.plug_id !== portPlugId) return false;
  if (isThisPortHovered) return false;
  if (isThisPortSelected) return false;
  return true;
}

export function isCompatible(sourcePortType: string | null, targetPort: LDrawPort): boolean {
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
  showVisuals: boolean;
  /** B.2：click handler 接收 shiftKey 让 callsite 决定是否走 plug 模式。
   *  Optional 第二参数保持向后兼容（旧 callsite 忽略即可）。 */
  onPortClick?: (info: SelectedPortInfo, opts?: { shiftKey: boolean }) => void;
  onPortHover?: (info: SelectedPortInfo | null) => void;
}

// 球体半径：7 LDU (2.8mm)。标准孔半径约 6 LDU (2.4mm)。
// 略大于孔径，用于纯几何 Hover 拦截，防止射线穿模导致闪烁。
const GIZMO_SPHERE_R_ENLARGED = 7 * LDU;

// B.1：plug-sibling halo 比 hit-box 略大，alpha 较高、不写深度 — 让用户
// 第一眼看见 plug 边界。原 alpha 0.35 在 Technic Beam 9 这种小孔密集
// 部件上肉眼难辨；提到 0.75 + 加大半径 + 改荧光黄绿，确保跟红色部件
// 主体 / 橙色 selected port arrow 都对比鲜明。
//
// Bug 4 follow-up：底面 plug member 在默认俯视 camera 下，halo 球壳虽然有
// depthTest:false 不被 beam 遮挡，但中心点本身在 beam 厚度内部，silhouette
// 投影只露出薄薄一圈。把半径 13→16 LDU（≈ 6.4mm，跨过 7-8mm 板厚），底面
// halo 在屏幕空间多出 ~50% 可见面积；同时保留 0.75 透明度，多 port 同时
// 亮时也不至于糊成一片。Trade-off：顶面 halo 也变大 → port 间距小（如
// 40490 那种 8mm 间距）时相邻 halo 略微重叠，但合 plug 视觉反而更"一体"，
// 不算 regression。
const PLUG_SIBLING_HALO_R = 16 * LDU;
const PLUG_SIBLING_HALO_COLOR = '#ffff00'; // 纯黄，最大对比
const PLUG_SIBLING_HALO_OPACITY = 0.75;

function PortArrow({
  port, sitePos, isSelected, isCompatiblePort, groupRef, partId, ldrawId, showVisuals, onPortClick, onPortHover
}: PortArrowProps) {
  const [hovered, setHovered] = useState(false);

  // B.1：plug-level 联动 — 订阅 hoveredPort，把 sibling 判定全权交给
  // 纯函数 shouldHaloPlugSibling（单测覆盖；改逻辑只动一处）。
  const hoveredPort = useStore(s => s.hoveredPort);
  const isPlugSibling = shouldHaloPlugSibling({
    portPlugId: port.plug_id,
    portPartId: partId,
    hoveredPort,
    isThisPortHovered: hovered,
    isThisPortSelected: isSelected,
  });

  const isLocallyActive = hovered || isSelected;
  const debugShowPorts = useStore(s => s.debugShowPorts);
  
  // 解除封印：只要父组件认为该端口热区处于激活态（showVisuals = true），视觉箭头就应当光明正大显示出来，不再要求悬停和 Debug
  const shouldShowVisuals = showVisuals;

  const genderColor = isFemale(port) ? '#2196f3' : '#e040fb';
  const ACTIVE_COLOR = '#ff9800'; // Source Locked 激活高亮色

  let color = genderColor;
  let opacity = 0.9;
  
  if (isSelected) {
    // 作为 Source 被选中时，它自身无需通过极性过滤（同极性相斥法则），必须强行高亮为原点色
    color = ACTIVE_COLOR;
    opacity = 0.9;
  } else {
    // 未选中态（彻底摒弃 Hover 视觉差，贯彻盲操原则）
    if (!isCompatiblePort) {
      color = '#444444'; // 不兼容：暗灰色
      opacity = 0.2;
    } else {
      color = genderColor; // 默认极性色
      opacity = 0.9;
    }
  }

  const pos = port.position as Vec3;
  const renderPos = useMemo((): Vec3 => [
    pos[0] - sitePos[0],
    pos[1] - sitePos[1],
    pos[2] - sitePos[2],
  ], [pos, sitePos]);

  const quaternion = useMemo(() => computePortQuaternion(port.rotation), [port.rotation]);

  const buildPortInfo = useCallback((): SelectedPortInfo => {
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
      position: pos,
      rotation: port.rotation as Mat3,
      globalPos: [worldPos.x, worldPos.y, worldPos.z],
      globalQuat: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
      plug_id: port.plug_id,  // B.1：透传给 store hoveredPort 让兄弟 port 联动
    };
  }, [pos, quaternion, groupRef, partId, ldrawId, port]);

  const direction = useMemo(() => {
    return new THREE.Vector3(
      port.rotation[0][2], port.rotation[1][2], port.rotation[2][2]
    ).normalize();
  }, [port.rotation]);

  useEffect(() => {
    return () => {
      if (hovered) {
        document.body.style.cursor = 'auto';
        onPortHover?.(null);
      }
    };
  }, [hovered, onPortHover]);

  const handlePointerOver = useCallback((e: any) => {
    // 绝对不能调用 e.stopPropagation()！
    if (!isCompatiblePort) return;
    // 移除 if (showVisuals) 检查：
    // 当鼠标第一时间划入时，可能父组件还未来得及响应并下发 showVisuals=true。
    // 如果这里被阻挡，会导致局部 hover 状态丢失，出现"高亮一下就消失"或根本不高亮的 Bug。
    setHovered(true);
    document.body.style.cursor = 'pointer';
    onPortHover?.(buildPortInfo());
  }, [isCompatiblePort, onPortHover, buildPortInfo]);

  const handlePointerOut = useCallback((e: any) => {
    // 不在这里防抖：每个 PortArrow 各自延时会让"用户从端口 A 移到端口 B"出问题——
    // A 的 out 定时器到期后会盖掉 B 已经写入的 hoveredPort，造成 ghost 在 A→B 切换时
    // 闪没。统一在 store.setHoveredPort 里做单源防抖，全局只有一个待决 null。
    setHovered(false);
    document.body.style.cursor = 'auto';
    onPortHover?.(null);
  }, [onPortHover]);

  return (
    <group 
      position={renderPos}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      onPointerDown={(e) => {
        if (!isCompatiblePort) return;
        e.stopPropagation();
      }}
      onClick={(e) => {
        // [防误触终极防护] 如果从按下到抬起，鼠标位移超过 5 个像素，判定为用户在“拖拽视角”而非“点击端口”。
        // 直接忽略并拦截该事件，不向上也不向内传播。
        if (e.delta > 5) {
            e.stopPropagation();
            return;
        }
        if (!isCompatiblePort) return;
        e.stopPropagation();
        // B.2：Shift+Click → 上层决定走 plug-anchor 路径
        onPortClick?.(buildPortInfo(), { shiftKey: !!(e as unknown as { shiftKey?: boolean }).shiftKey });
      }}
      onDoubleClick={(e) => {
        if (!showVisuals) return;
        e.stopPropagation();
      }}
    >
      {/* 视觉箭头：仅当精确悬停或选中时 (shouldShowVisuals=true) 渲染 */}
      {shouldShowVisuals && (
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
      )}
      
      {/* 根部拦截球体（核心兜底）：始终存在。
          它是纯几何 Hover 拦截的核心，同时也是触发局部悬停的精确热区。
          当未被悬停时，透明且不写深度，但参与射线检测，防止鼠标落入孔洞。 */}
      <mesh quaternion={quaternion}>
        <sphereGeometry args={[GIZMO_SPHERE_R_ENLARGED, 16, 16]} />
        <meshBasicMaterial 
          color={color} 
          toneMapped={false} 
          opacity={shouldShowVisuals ? opacity : 0} 
          transparent 
          depthWrite={shouldShowVisuals}
          colorWrite={shouldShowVisuals}
        />
      </mesh>

      {/* 独立封装的完美方向性碰撞热区 (Directional Hitbox)：仅激活时渲染并接受点击 */}
      {isCompatiblePort && showVisuals && (
        <mesh
          position={new THREE.Vector3().copy(direction).multiplyScalar(ARROW_LENGTH / 2)}
          quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)}
          renderOrder={999}
        >
          <cylinderGeometry args={[10 * LDU, 10 * LDU, ARROW_LENGTH, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {/* B.1：plug-sibling halo — 当某个兄弟 port hover 时本 port 加一层
          暖黄半透明球壳。纯发现性反馈，不参与 raycast。
          depthTest 也关掉 — port 物理上嵌入零件 mesh 内（孔在板中），
          halo 球壳会被 beam 实体部分遮挡 → 用户只看到端口附近的 halo。
          关 depthTest 让 halo "穿透"显示，所有 plug member 一视同仁。 */}
      {isPlugSibling && shouldShowVisuals && (
        <mesh raycast={() => {}} renderOrder={1000}>
          <sphereGeometry args={[PLUG_SIBLING_HALO_R, 16, 16]} />
          <meshBasicMaterial
            color={PLUG_SIBLING_HALO_COLOR}
            toneMapped={false}
            opacity={PLUG_SIBLING_HALO_OPACITY}
            transparent
            depthWrite={false}
            depthTest={false}
          />
        </mesh>
      )}
    </group>
  );
}

// ─── 主组件：SiteGizmo ─────────────────────────────────────────────────────

export interface SiteGizmoProps {
  site: LDrawSite;
  groupRef: React.RefObject<THREE.Group>;
  partId: string;
  ldrawId: string;
  phase: InteractionPhase;
  sourcePortType?: string | null;
  selectedPort?: SelectedPortInfo | null;
  /** B.2：当前 plug 选择模式。PLUG 时，所有跟 selectedPort 同 plug
   *  的 member port 都视为 isSelected（橙色高亮，不只是 selectedPort 单颗）。 */
  portSelectionLevel?: SelectionLevel;
  showVisuals: boolean;
  /** 该零件上已被占用（已被对端塞住）的端口 key 集合；命中即整体跳过渲染。 */
  occupiedKeys?: Set<string>;
  onPortClick?: (info: SelectedPortInfo, opts?: { shiftKey: boolean }) => void;
  onPortHover?: (info: SelectedPortInfo | null) => void;
}

export function SiteGizmo({
  site, groupRef, partId, ldrawId, phase, sourcePortType = null,
  selectedPort, portSelectionLevel, showVisuals, occupiedKeys, onPortClick, onPortHover
}: SiteGizmoProps) {
  const sitePos = site.position as Vec3;

  return (
    <group position={sitePos}>
      {site.ports.map((port, idx) => {
        const compatible = isCompatible(
          sourcePortType,
          port
        );

        const portPos = port.position as Vec3;
        const portIsExactSelected = !!selectedPort
          && selectedPort.partId === partId
          && Math.abs(selectedPort.position[0] - portPos[0]) < 1e-4
          && Math.abs(selectedPort.position[1] - portPos[1]) < 1e-4
          && Math.abs(selectedPort.position[2] - portPos[2]) < 1e-4;
        // B.2：PLUG 选择模式下，所有同 plug member 都视为 selected（橙色）
        const portIsPlugMember = portSelectionLevel === SelectionLevel.PLUG
          && !!selectedPort
          && selectedPort.partId === partId
          && !!selectedPort.plug_id
          && !!port.plug_id
          && selectedPort.plug_id === port.plug_id;
        const portIsSelected = portIsExactSelected || portIsPlugMember;

        // 占用过滤：portKey 已经把端口的 Z 轴方向也算进 key，所以同位置不同方向的端口
        // （比如 2780 销 site 里 p0/p1 共享 (0,0,0) 但方向相反）只会有"被 snap 实际用掉的
        // 那一端"被命中、被隐藏；销的另一端仍然可见、可作为新的 source 反向吸附别的孔。
        // 灰板的孔属于单方向 FEMALE，被插上后这里直接挡掉，避免"误点已占用孔→源极性变成
        // 同性→所有目标不兼容→没幽灵"的连锁假象。
        if (occupiedKeys && occupiedKeys.has(portKey(portPos, port.rotation)) && !portIsSelected) {
          return null;
        }

        return (
          <PortArrow
            key={`${site.id}_port_${idx}`}
            port={port}
            sitePos={sitePos}
            isSelected={portIsSelected}
            isCompatiblePort={compatible}
            groupRef={groupRef}
            partId={partId}
            ldrawId={ldrawId}
            showVisuals={showVisuals}
            onPortClick={onPortClick}
            onPortHover={onPortHover}
          />
        );
      })}
    </group>
  );
}

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
import type { LDrawSite, LDrawPort, LDrawPlug } from '../useLDrawPart';
import type { Vec3, Mat3, SelectedPortInfo } from '../types';
import { InteractionPhase, SelectionLevel } from '../types';
import { useStore, portKey } from '../store';
import { isConnectorCategory } from '../utils/partCategory';

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
 * B.1（v2，UX 反馈迭代）：plug hover 反馈从"每孔叠一个黄球"改为"整个 plug
 * 画一圈线框轮廓"。原方案在 40490 这种 8mm 间距密集孔梁上，18 个 16-LDU 球
 * 重叠糊成一坨黄，看不清单个孔。改用 part-local 包围盒线框：既表达"这一整组
 * 是一个 plug"，又不遮住孔/箭头。
 *
 * 本纯函数算 plug 的 part-local AABB（让 __tests__ 直接验，不走 React）：
 *   - hoveredPort 为空 / 无 plug_id / 不在本 part → null（不画）
 *   - 找不到对应 plug / plug member < 2 → null（单 port plug 画框没意义）
 *   - 否则聚所有 member 的 port.position 求 AABB，按 margin 外扩，并对每个轴
 *     施加 minThickness 防"共面 plug 退化成 0 厚度面"看不见
 *
 * 返回的 center/size 是 part-local 坐标，直接喂给挂在 part group（groupRef，
 * 已携带世界位姿）下的 BoxGeometry。
 */
export interface PlugOutlineBox {
  center: Vec3;
  size: Vec3;
}

export function computePlugOutlineBox(args: {
  hoveredPort: SelectedPortInfo | null;
  partId: string;
  plugs: LDrawPlug[];
  sites: LDrawSite[];
  margin?: number;
  minThickness?: number;
}): PlugOutlineBox | null {
  const {
    hoveredPort, partId, plugs, sites,
    margin = 9 * LDU, minThickness = 6 * LDU,
  } = args;
  if (!hoveredPort || !hoveredPort.plug_id) return null;
  if (hoveredPort.partId !== partId) return null;
  const plug = plugs.find(p => p.plug_id === hoveredPort.plug_id);
  if (!plug || plug.members.length < 2) return null;

  const siteMap = new Map(sites.map(s => [s.id, s]));
  const pts: Vec3[] = [];
  for (const [siteId, portIdx] of plug.members) {
    const port = siteMap.get(siteId)?.ports?.[portIdx];
    if (port) pts.push(port.position as Vec3);
  }
  if (pts.length < 2) return null;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }

  const center: Vec3 = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const size: Vec3 = [
    Math.max(max[0] - min[0] + 2 * margin, minThickness),
    Math.max(max[1] - min[1] + 2 * margin, minThickness),
    Math.max(max[2] - min[2] + 2 * margin, minThickness),
  ];
  return { center, size };
}

/**
 * 端口是否"显著高亮"（画完整箭头 + 全亮球）的纯判定（便于单测）。
 * 规则：
 *   - 精确 hover 到端口 + 连接模式(Alt) → 高亮（非连接件/大板：精确 hover 才亮）；
 *   - 已选源端口 / Debug 全显 → 恒高亮；
 *   - 连接件(销/轴/连接器)：端口埋在体内难精确 hover，故「本件激活(hover/选中) + 端口
 *     兼容」即整件端口全亮（朝外箭头露出体外 → 可见可点），**不要求按 Alt**。
 *     原因：端口"显示"过去依赖 store.isPortModifierHeld（keydown/pointermove 同步），
 *     而在 Mac(Option)→RDP→Windows 链路上该状态不稳 → 销端口"经常不显示"。点击连接
 *     仍读事件级 altKey（稳），故只放开"显示"不放开"点击"。大板等密集件不走此路
 *     （390 孔全亮会铺满），仍按精确 hover + Alt。
 */
export function portProminent(args: {
  hovered: boolean;
  portEngageMode: boolean;
  isSelected: boolean;
  debugShowPorts: boolean;
  isConnectorPart: boolean;
  shouldShowVisuals: boolean;
  isCompatiblePort: boolean;
}): boolean {
  const { hovered, portEngageMode, isSelected, debugShowPorts, isConnectorPart, shouldShowVisuals, isCompatiblePort } = args;
  const connectorProminent = isConnectorPart && shouldShowVisuals && isCompatiblePort;
  return (hovered && portEngageMode) || isSelected || debugShowPorts || connectorProminent;
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
  /** 该零件端口总数是否超过密集阈值（用于抑制大板上铺满的淡化点）。 */
  isDensePart?: boolean;
  /** 该零件是否为连接件（销/轴/连接器）。端口埋在体内难精确 hover，Alt+激活时全亮。 */
  isConnectorPart?: boolean;
  /** B.2：click handler 接收 shiftKey 让 callsite 决定是否走 plug 模式。
   *  Optional 第二参数保持向后兼容（旧 callsite 忽略即可）。 */
  onPortClick?: (info: SelectedPortInfo, opts?: { shiftKey: boolean }) => void;
  onPortHover?: (info: SelectedPortInfo | null) => void;
}

// 球体半径：7 LDU (2.8mm)。标准孔半径约 6 LDU (2.4mm)。
// 略大于孔径，用于纯几何 Hover 拦截，防止射线穿模导致闪烁。
const GIZMO_SPHERE_R_ENLARGED = 7 * LDU;

// B.1（v2）：plug hover 反馈用整组线框轮廓（见 PlugSiblingOutline），不再每孔
// 叠球。荧光黄、不写/不测深度，确保从任意相机角度都能穿过 beam 实体看到。
const PLUG_OUTLINE_COLOR = '#ffd400';
const PLUG_OUTLINE_OPACITY = 0.95;

// 方案 1（UX 反馈）：part-hover 展开全部 port 时，只有鼠标直接悬停 / 选中的 port
// 画成完整方向箭头 + 全亮球；其余 port 淡化成低透明度小点 —— 既保留"哪里有孔"
// 的可发现性，又消除密集孔梁（如 40490）一次性弹 18 个箭头的视觉杂讯。
// Debug「Show All Ports」仍强制全亮箭头，是已有逃生口。
const DIMMED_PORT_OPACITY = 0.2;

// 密集件门控（UX 反馈）：端口总数超过此阈值的零件（如 39369 大板 390 孔），
// hover/选中时若把每个孔都画淡化小球，会铺满整块板成一片"深色印记"+ 上百个
// sphere mesh 拖性能。超阈值件 → 非 prominent 端口不画可见点（hit-zone 不可见
// 球壳保留，hover 检测不变），只留直接 hover 那颗 + plug 轮廓。
export const DENSE_PORT_THRESHOLD = 40;

/**
 * 端口指示球的可见性决策（纯函数，便于单测）。
 *   - 未展开（showVisuals=false）→ 全透明（仅 hit-zone）
 *   - prominent（直接 hover / 选中 / Debug 全显）→ 全亮 baseOpacity + 画箭头
 *   - 仅 part-hover 展开的"其余"端口：稀疏件淡化成 DIMMED_PORT_OPACITY 小点；
 *     密集件直接隐藏（opacity 0 + colorWrite false），避免铺满。
 */
export function portDotVisuals(args: {
  shouldShowVisuals: boolean;
  prominent: boolean;
  isDensePart: boolean;
  baseOpacity: number;
}): { sphereOpacity: number; colorWrite: boolean; showArrow: boolean } {
  const { shouldShowVisuals, prominent, isDensePart, baseOpacity } = args;
  if (!shouldShowVisuals) return { sphereOpacity: 0, colorWrite: false, showArrow: false };
  if (prominent) return { sphereOpacity: baseOpacity, colorWrite: true, showArrow: true };
  if (isDensePart) return { sphereOpacity: 0, colorWrite: false, showArrow: false };
  return { sphereOpacity: DIMMED_PORT_OPACITY, colorWrite: true, showArrow: false };
}

/**
 * 端口点击意图（纯函数，便于单测）。
 *
 * UX 反馈：端口点和零件本体的点击老是混淆——想选零件却点中端口、误进
 * SOURCE_LOCKED。改为「修饰键区分」：
 *   - 裸点（无修饰键）→ 不进端口（engage=false），事件放行给零件本体 → 选中本体；
 *   - 按住 Alt/Option 点端口 → 进端口（engage=true），锁源端口 / 选目标端口发起连接；
 *   - Alt + Shift → 整片 plug 锚点（plugLevel=true）。
 *
 * 仅在 engage 时才 stopPropagation + 调 onPortClick；否则一律下落到本体。 */
export function portClickIntent(mods: { altKey?: boolean; shiftKey?: boolean }): {
  engage: boolean;
  plugLevel: boolean;
} {
  const engage = !!mods.altKey;
  const plugLevel = engage && !!mods.shiftKey;
  return { engage, plugLevel };
}

function PortArrow({
  port, sitePos, isSelected, isCompatiblePort, groupRef, partId, ldrawId, showVisuals, isDensePart = false, isConnectorPart = false, onPortClick, onPortHover
}: PortArrowProps) {
  const [hovered, setHovered] = useState(false);

  const debugShowPorts = useStore(s => s.debugShowPorts);
  // Feature B 修饰键模型：端口只有在"连接模式"（按住 Alt）下 hover 才点亮 + 指针
  // 手型。裸 hover（无 Alt）不点亮 —— 因为裸点是选本体、不连接，点亮会误导用户
  // 以为端口可点。已锁定的源端口（isSelected）和 Debug 全显仍恒亮。
  const portEngageMode = useStore(s => s.isPortModifierHeld);

  // showVisuals = 父组件认为该 part 处于激活态（hover / 选中 / static）→ port 热区
  // 始终渲染（拦射线）。可见强度交给 portDotVisuals 纯函数（单测覆盖）按
  // prominent / 密集件分档。
  const shouldShowVisuals = showVisuals;
  const prominent = portProminent({
    hovered, portEngageMode, isSelected, debugShowPorts, isConnectorPart, shouldShowVisuals, isCompatiblePort,
  });

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

  // 可见性分档（含密集件抑制淡化点）。baseOpacity = 上面算出的 prominent 全亮值。
  const dot = portDotVisuals({ shouldShowVisuals, prominent, isDensePart, baseOpacity: opacity });

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

  // 指针手型：仅在 hover 且"连接模式"（Alt 按住）+ 兼容端口时显示，表达"现在点
  // 可连接"。由 effect 驱动（而非 pointerOver 内一次性写），这样 hover 中途按下/
  // 松开 Alt 也能实时切换手型。unmount/hover 结束时复位。
  useEffect(() => {
    if (hovered && portEngageMode && isCompatiblePort) {
      document.body.style.cursor = 'pointer';
    } else if (hovered) {
      document.body.style.cursor = 'auto';
    }
    return () => {
      if (hovered) {
        document.body.style.cursor = 'auto';
        onPortHover?.(null);
      }
    };
  }, [hovered, portEngageMode, isCompatiblePort, onPortHover]);

  const handlePointerOver = useCallback((e: any) => {
    // 绝对不能调用 e.stopPropagation()！
    if (!isCompatiblePort) return;
    // 移除 if (showVisuals) 检查：
    // 当鼠标第一时间划入时，可能父组件还未来得及响应并下发 showVisuals=true。
    // 如果这里被阻挡，会导致局部 hover 状态丢失，出现"高亮一下就消失"或根本不高亮的 Bug。
    setHovered(true);
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
        // 修饰键区分（UX 反馈）：只有按住 Alt「进端口」时才吃掉事件，否则放行给
        // 零件本体 onPointerDown → 选中本体。裸点端口不再误进 SOURCE_LOCKED。
        if ((e as unknown as { altKey?: boolean }).altKey) e.stopPropagation();
      }}
      onClick={(e) => {
        // [防误触终极防护] 如果从按下到抬起，鼠标位移超过 5 个像素，判定为用户在“拖拽视角”而非“点击端口”。
        // 直接忽略并拦截该事件，不向上也不向内传播。
        if (e.delta > 5) {
            e.stopPropagation();
            return;
        }
        if (!isCompatiblePort) return;
        const mods = e as unknown as { altKey?: boolean; shiftKey?: boolean };
        const intent = portClickIntent({ altKey: mods.altKey, shiftKey: mods.shiftKey });
        // 裸点：不进端口，放行（本体已在 pointerdown 选中）。Alt 才发起连接。
        if (!intent.engage) return;
        e.stopPropagation();
        // Alt+Shift → 上层走 plug-anchor 路径（plugLevel）；Alt → INDIVIDUAL 端口。
        onPortClick?.(buildPortInfo(), { shiftKey: intent.plugLevel });
      }}
      onDoubleClick={(e) => {
        if (!showVisuals) return;
        e.stopPropagation();
      }}
    >
      {/* 视觉箭头：仅当 prominent（直接悬停 / 选中 / Debug 全显）才画完整箭头。
          方案 1：part-hover 仅展开热区时不画 18 个箭头，只留下面淡化的小球点。 */}
      {dot.showArrow && (
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
          opacity={dot.sphereOpacity}
          transparent
          depthWrite={shouldShowVisuals && prominent}
          colorWrite={dot.colorWrite}
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

      {/* B.1（v2）：plug-sibling 反馈已上移到 part 层的 PlugSiblingOutline
          （整组线框轮廓），PortArrow 不再画 per-port halo 球。 */}
    </group>
  );
}

// ─── PlugSiblingOutline：plug hover 整组线框轮廓（part 层渲染） ───────────────

export interface PlugSiblingOutlineProps {
  partId: string;
  plugs: LDrawPlug[];
  sites: LDrawSite[];
}

/**
 * 渲染"被 hover 的 plug"的 part-local 包围盒线框。挂在 InteractivePart 的
 * groupRef（携带世界位姿）下，跟 SiteGizmo 同帧。订阅 store.hoveredPort，
 * 几何由 computePlugOutlineBox 纯函数算（单测覆盖）。线框用 EdgesGeometry
 * （只 12 条棱、无对角线），depthTest 关 → 穿过 beam 实体可见。
 */
export function PlugSiblingOutline({ partId, plugs, sites }: PlugSiblingOutlineProps) {
  const hoveredPort = useStore(s => s.hoveredPort);

  const box = useMemo(
    () => computePlugOutlineBox({ hoveredPort, partId, plugs, sites }),
    [hoveredPort, partId, plugs, sites],
  );

  const edges = useMemo(() => {
    if (!box) return null;
    const boxGeo = new THREE.BoxGeometry(box.size[0], box.size[1], box.size[2]);
    const e = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    return e;
  }, [box]);

  // EdgesGeometry 经 geometry prop 传入 → R3F 不自动 dispose，手动在变更/卸载时释放
  useEffect(() => () => { edges?.dispose(); }, [edges]);

  if (!box || !edges) return null;
  return (
    <lineSegments
      geometry={edges}
      position={box.center}
      raycast={() => {}}
      renderOrder={1000}
    >
      <lineBasicMaterial
        color={PLUG_OUTLINE_COLOR}
        transparent
        opacity={PLUG_OUTLINE_OPACITY}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </lineSegments>
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
  /** 该零件端口总数是否超过密集阈值（抑制大板铺满的淡化点）。 */
  isDensePart?: boolean;
  onPortClick?: (info: SelectedPortInfo, opts?: { shiftKey: boolean }) => void;
  onPortHover?: (info: SelectedPortInfo | null) => void;
}

export function SiteGizmo({
  site, groupRef, partId, ldrawId, phase, sourcePortType = null,
  selectedPort, portSelectionLevel, showVisuals, occupiedKeys, isDensePart = false, onPortClick, onPortHover
}: SiteGizmoProps) {
  const sitePos = site.position as Vec3;
  // 连接件（销/轴/连接器）：端口数少且埋在体内，Alt+激活时整件端口全亮（见 PortArrow）。
  const isConnectorPart = useStore(s => isConnectorCategory(s.partCatalog[ldrawId]?.category));

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
            isDensePart={isDensePart}
            isConnectorPart={isConnectorPart}
            onPortClick={onPortClick}
            onPortHover={onPortHover}
          />
        );
      })}
    </group>
  );
}

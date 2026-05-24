import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import axios from 'axios';
import {
  InteractionPhase,
  SelectionLevel,
  SelectionAnchor,
  InterferenceReport,
  PartCatalogEntry,
  ReactionData,
  PartState,
  Vec3,
  Quat,
  Mat3,
  SelectedPortInfo,
  ZoneType,
  FreePlacingProjectionMode
} from './types';
import { isValidTransition } from './interactionFSM';
import { StagingGrid } from './staging';
import { HistoryStack, createSnapCommand, TopologySnapshot, createTopologyCommand } from './historyStack';
import { calculateSnapPose, calculatePortRotationPose, applyGroupDelta, calculateClampedOffset, quatTimesAxisAngle } from './utils/snapMath';
import { evaluateRotateReconnect, worldPivot, rotatePartAboutPivot, pickBasePart, type RigidPose } from './utils/rotateReconnect';
import { isConnectorCategory } from './utils/partCategory';
import {
  findMeshPartnerAndDelta,
  rotateGearAroundOwnAxis,
  type GearPart,
} from './utils/gearMath';
import { getDefaultColorCode, hasPresetColor } from './utils/partColorDefaults';

type ConnectionGraph = Record<string, Set<string>>;

/**
 * 端口占用映射：partId -> (端口本地坐标 key -> 占用方 partId)。
 * - key 由 portKey() 序列化端口本地坐标得到（4 位小数 ≈ 100 µm，远高于 LDU 颗粒度 0.4 mm）。
 * - value 记录把它"塞住"的对端 partId，用于在删除任意一端时回收对面的占用条目。
 *
 * 该结构与 connections（零件级邻接）平行存在：connections 维持图遍历语义不变；
 * occupiedPorts 给前端渲染层提供 O(1) 的"这个端口是否已被占用"查询，
 * 使 SiteGizmo 能直接隐藏被插销塞住的孔，避免误点已占用孔产生的极性不兼容假象。
 */
type OccupiedPortMap = Record<string, Record<string, string>>;

/**
 * 端口标识 → 字符串 key（用于占用集查询）。位置 + Z 轴方向同时参与序列化，
 * 因为 LDraw 里同位置的端口可能存在方向相反的两个（销零件 2780 就是典型，
 * site 内 p0/p1 同坐标 (0,0,0) 但 Z 轴方向相反，分别表示从两端插入）。
 * 仅按位置区分会把两个端口压成同一个 key，导致 snap 占用一端后另一端也被误隐藏。
 *
 * 导出给渲染层做同源序列化。Z 轴 = port.rotation 矩阵的第三列。
 */
export const portKey = (pos: Vec3, rotation?: Mat3): string => {
  const base = `${pos[0].toFixed(4)},${pos[1].toFixed(4)},${pos[2].toFixed(4)}`;
  if (!rotation) return base;
  const r = rotation as number[][];
  if (!Array.isArray(r) || !Array.isArray(r[0])) return base;
  const zx = (r[0]?.[2] ?? 0);
  const zy = (r[1]?.[2] ?? 0);
  const zz = (r[2]?.[2] ?? 0);
  return `${base}|${zx.toFixed(2)},${zy.toFixed(2)},${zz.toFixed(2)}`;
};

const API_URL = 'http://localhost:8000';

interface StoreLog {
    timestamp: number;
    type: 'INFO' | 'ACTION' | 'ERROR' | 'PHYSICS';
    message: string;
    /** 连续相同（message+type）日志折叠计数。≥2 时 UI 显示 "(×N)"，
     *  避免过约束锁死这类高频重复日志刷屏淹没其它条目。 */
    count?: number;
}

interface StoreState {
  mode: 'ASSEMBLY' | 'SIMULATION';
  /** toggleMode 失败时的最近错误（issue #63）。成功后清。UI 层订阅显示 toast / status。 */
  modeToggleError: string | null;
  /** toggleMode 进行中状态（issue #63）。true 时按钮应 disabled 防双击。 */
  modeToggling: boolean;
  /** UI 主视图选择（issue #64 C.3 重命名前为 'ASSEMBLY' | 'LIBRARY_VERIFY'，
   *  跟 mode='ASSEMBLY' 字面值重叠，TypeScript 无法区分。改为
   *  'EDITOR' | 'WORKBENCH' 直接对应 AssemblyUI / VerificationWorkbench。 */
  view: 'EDITOR' | 'WORKBENCH';
  parts: Record<string, PartState>;
  connections: ConnectionGraph;
  /** 端口占用图：见 OccupiedPortMap 注释。 */
  occupiedPorts: OccupiedPortMap;
  wsConnected: boolean;
  selectedPort: SelectedPortInfo | null;
  hoveredPort: SelectedPortInfo | null;
  slidingTarget: SelectedPortInfo | null; // 正在滑动的目标参考点
  interactionPhase: InteractionPhase;
  focusedPartId: string | null;
  focusMode: 'part' | 'assembly' | null;
  showPortGizmos: boolean;
  enableFocusAnimation: boolean;
  enableSSAO: boolean;
  enableContactShadows: boolean;
  debugMode: boolean;
  debugShowPorts: boolean;
  /** 端口连接修饰键（Alt/Option）当前是否按住。瞬态 UI 态，不持久化。
   *  端口点只有在"连接模式"（Alt 按住）下才高亮 + 指针手型，避免裸点选本体时
   *  端口高亮误导用户以为可点（见 SiteGizmo / Feature B 修饰键交互模型）。 */
  isPortModifierHeld: boolean;
  /** 框选矩形（屏幕像素，fixed 定位）。瞬态：Canvas 内控制器拖拽时写入，
   *  Canvas 外的 MarqueeBox 据此渲染 HTML 矩形（不能在 R3F 树里渲染 div）。
   *  null = 当前没有框选拖拽。 */
  marqueeBox: { left: number; top: number; width: number; height: number } | null;
  previewPartId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  stagingGrid: StagingGrid;
  snapPreState: {
    movedPartIds: string[];
    prevPositions: Record<string, { position: Vec3; quaternion: Quat }>;
    addedConnections: Array<{ from: string; to: string }>;
    addedPartIds?: string[];
    /** Snap 引入的端口占用条目，撤销/中止时按这份清单回滚。 */
    addedPortKeys?: Array<{ partId: string; key: string; peerId: string }>;
  } | null;
  continuousPlacementSource: SelectedPortInfo | null; // 用于记录正在连续放置（复制）的源端口信息

  /**
   * 全局活跃颜色码 (LDraw Color Code)。
   * 从颜色选择器写入，在创建零件实例时作为 colorCode 默认值注入。
   * 默认值 4 (Red) 仅作为示例；实际工程中应由用户在 UI 中显式选取。
   */
  activeColorCode: number;
  
  // 日志系统
  logs: StoreLog[];
  showLogPanel: boolean;
  isContextLost: boolean;

  /** Cmd+K 全局搜索面板的开/关状态。从 App.jsx 局部 useState 提到 store
   *  让 useKeyboardDispatcher 能 phase-aware 路由 Esc（issue #64 #1）。 */
  isSearchOpen: boolean;

  /** 走法 A 期 B.2：port-level 选择的粒度。
   *   - INDIVIDUAL: 单 port 选中（默认；普通 click）
   *   - PLUG:      整片 plug 选中（Shift+Click；视觉上 plug 全 member
   *                橙色高亮，selectedPort 落在 plug anchor port）
   *  GROUP 在此字段无意义（GROUP 是 selection.level 的部分级别 — 见上）。 */
  portSelectionLevel: SelectionLevel;

  /** 走法 A 期 B.3-3：上一次 snap 命中的 port-pair 总数（含主连接 + 后端
   *  Auto-Latch 闭合的对）。 用户在 PLUG mode 整片 snap 后用来给 UX
   *  反馈"刚才一次性插了 N 颗"。0 表示无最近 snap / 已被新交互清。
   *  abort/deselect/下一次 port click 重置。 */
  lastSnapPairCount: number;

  /** 走法 A 期 B.3-extension：pre-commit 预览 — SOURCE_LOCKED + PLUG 模式
   *  下，hover target plug 时算 min(source.plug_port_count, target_plug
   *  .port_count) 作为预计闭合 pair 数上界。null 表示无预测（不在 PLUG
   *  hover 状态 / 不兼容 / 装饰类零件）。 上界，不是精确值 — 实际几何
   *  错位时 Auto-Latch 可能漏检；commit 后由 lastSnapPairCount 给真值。 */
  predictedSnapPairCount: number | null;

  // v1.2 State
  selection: {
    primaryId: string | null;
    level: SelectionLevel;
    allConnectedIds: string[];
    excludedIds: string[];
  };
  clipboard: { id: string; state: PartState }[];
  freePlacingPayload: { id: string; state: PartState }[];
  freePlacingPointer: { clientX: number; clientY: number } | null;
  freePlacingProjectionMode: FreePlacingProjectionMode;
  /** 粘贴时随 payload 一起带的"组内连接 + 占用"（id 已 remap 到新实例）。commit 时
   *  一并建连/写占用，让粘出来的副本保持连接（销仍插在板上），而非散件。null = 非粘贴。 */
  freePlacingMeta: {
    connections: Array<{ from: string; to: string }>;
    occupied: Record<string, Record<string, string>>;
  } | null;
  hiddenParts: Set<string>;
  interferenceReport: InterferenceReport;
  slideOffset: number;
  cameraTarget: [number, number, number] | null;
  partUsages: Record<string, number>;
  /** L44 / L50：ldrawId → 后端 /api/get_verified_parts 元数据。
   *  PartLibraryPanel 拉取后填入；snapParts 用 toothCount 做齿轮咬合相位对齐。 */
  partCatalog: Record<string, PartCatalogEntry>;
  /** L51b PR-B：上次 /api/compute_reactions 返回的反力 map（可空）。 */
  reactionForces: Record<string, ReactionData>;
  /** L51b PR-B：是否在 Scene 上渲染反力可视化（默认关，避免视觉过载）。 */
  showReactionForces: boolean;

  // Actions
  reset: () => void;
  setPartCatalog: (catalog: Record<string, PartCatalogEntry>) => void;
  /** L51b PR-B：拉一次反力，写入 reactionForces。失败时不抛，写空对象。 */
  refreshReactionForces: () => Promise<void>;
  setShowReactionForces: (v: boolean) => void;
  setView: (view: 'EDITOR' | 'WORKBENCH') => void;
  toggleMode: () => Promise<void>;
  updatePartState: (partId: string, state: Partial<PartState>) => void;
  batchUpdatePartStates: (updates: Record<string, Partial<PartState>>) => void;
  setWsConnected: (status: boolean) => void;
  setFocus: (focus: { partId: string | null; mode: 'part' | 'assembly' | null }) => void;
  setCameraTarget: (target: [number, number, number] | null) => void;
  setShowPortGizmos: (value: boolean) => void;
  setEnableFocusAnimation: (value: boolean) => void;
  setEnableSSAO: (value: boolean) => void;
  setEnableContactShadows: (value: boolean) => void;
  setDebugMode: (value: boolean) => void;
  setDebugShowPorts: (value: boolean) => void;
  setPortModifierHeld: (value: boolean) => void;
  setPartZone: (partId: string, zone: ZoneType) => void;

  /** 全局颜色选择：更新 activeColorCode，后续所有零件实例使用此颜色 */
  setActiveColorCode: (code: number) => void;
  /** 给当前选中的零件改色（colorCode）。作用范围 = selection.allConnectedIds；
   *  功能预设色件（销/轴等 hasPresetColor）跳过不改。可撤销。返回实际改色件数。 */
  recolorSelected: (code: number) => void;

  undo: () => void;
  redo: () => void;

  handlePortClick: (port: SelectedPortInfo) => Promise<void>;
  setHoveredPort: (port: SelectedPortInfo | null) => void;
  snapParts: (source: SelectedPortInfo, target: SelectedPortInfo, slideOffset?: number, shiftKey?: boolean) => Promise<boolean>;
  abortCurrentInteraction: () => void;
  
  // 日志 Actions
  addLog: (msg: string, type?: StoreLog['type']) => void;
  clearLogs: () => void;
  toggleLogPanel: (show?: boolean) => void;
  // ── 命名约定（issue #64 #2 收口）──────────────────────────────────────────
  // boolean state 用 `is*` 前缀；其 setter **去掉 is**，名字表达 intent 而非
  // 字段名。全 store 一致：isSearchOpen→setSearchOpen / isContextLost→
  // setContextLost。新加 bool state 时照此办，别写成 setIsXxx。
  setContextLost: (lost: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setPortSelectionLevel: (level: SelectionLevel) => void;

  // v1.2 Actions
  deleteSelected: () => void;
  /** 脱开：把「选中件/组」从其余装配切离 —— 只断跨选区边界的连接边（选中↔未选中），
   *  保留选区内部连接，同步清对应 occupiedPorts，位置不变。可撤销。 */
  detachSelected: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  duplicateSelected: () => void;
  setHiddenSelected: (hide: boolean) => void;
  showAll: () => void;
  selectAll: () => void;
  deselectAll: () => void;
  setMarqueeSelection: (ids: string[]) => void;
  /** 写框选矩形（屏幕像素）；null 清除。供 Canvas 外 MarqueeBox 渲染。 */
  setMarqueeBox: (box: { left: number; top: number; width: number; height: number } | null) => void;

  addParts: (ids: string[]) => void;
  removeParts: (ids: string[]) => void;
  connectParts: (a: string, pa: string, b: string, pb: string) => void;
  selectPart: (id: string | null, level?: SelectionLevel, append?: boolean) => void;
  updateSelection: (level: SelectionLevel) => void;
  updateSlideOffset: (offset: number, shiftKey?: boolean) => void;
  rotateSelectedPart: (angleRads: number) => void;
  /** 已放置零件自由编辑（IDLE + selection）：绕世界 Y 轴整体旋转当前选中
   *  零件所在的连通组（pivot = primary 原点）。可撤销。 */
  rotateSelectedGroup: (angleRads: number) => void;
  /** 已放置零件自由编辑（IDLE + selection）：转「选中件 + 挂在其上的子装配」整体，
   *  相对「地基」（连通组里最大零件）。子装配随动、内部连接保持；只重连评估
   *  子装配↔地基界面（对齐保持 / 微移复原 / 否则脱开）。可撤销。 */
  rotateSelectedSingle: (angleRads: number) => void;
  /** 翻面：把「选中件 + 子装配」绕世界 X 轴翻转 180°（pivot = 包围盒中心），相对地基。
   *  翻面后若端口仍能对齐（自动微移）则保持连接，否则脱开。可撤销。 */
  flipSelected: () => void;
  /** 已放置零件自由编辑：把「选中件 + 子装配」整体平移 delta（世界系，米），地基不动。
   *  平移不做微移吸回（位移即意图）；移开后界面不再重合则脱开。可撤销。 */
  translateSelectedGroup: (delta: Vec3) => void;
  /** rotate/translateSelectedGroup 共用：算 moving 组（选中件+子装配，排除地基）、
   *  施加 makeNewPrimaryPose 给出的位姿、按 autoMove 重连/脱开界面、可撤销 + 日志。 */
  _transformSelectedSubassembly: (
    makeNewPrimaryPose: (oldPose: RigidPose, pivot: Vec3) => RigidPose,
    opts: { autoMove: boolean; label: string; keepConnectorsFixed?: boolean },
  ) => void;
  /** 内部 helper（rotate/translateSelectedGroup 共用）：给定 primary 新位姿，
   *  整组刚体应用 + 推可撤销命令 + ACTION 日志。 */
  _transformSelectedGroup: (newPrimaryPose: { position: Vec3; quaternion: Quat }, logMsg: string) => void;
  setBlocked: (report: InterferenceReport) => void;
  setPhase: (phase: InteractionPhase) => void;
  previewPart: (id: string | null) => void;
  stagePart: (id: string) => void;
  commitAxialSliding: () => void;
  focusCameraOnSelected: () => void;
  startFreePlacing: (
    ldrawId: string,
    colorCode: number,
    options?: {
      pointer?: { clientX: number; clientY: number } | null;
      projectionMode?: FreePlacingProjectionMode;
    }
  ) => void;
  commitFreePlacing: (finalStates?: Record<string, PartState>) => void;
}

const quatNormalize = (q: [number, number, number, number]): Quat => {
  const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]) || 1;
  return [q[0]/len, q[1]/len, q[2]/len, q[3]/len];
};

const getQuatFromMat3 = (m: Mat3): Quat => {
  const mm = m as number[][];
  const nm: number[][] = [];
  for (let col = 0; col < 3; col++) {
    const v = [mm[0][col], mm[1][col], mm[2][col]];
    const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
    nm.push([v[0]/len, v[1]/len, v[2]/len]);
  }
  
  const m11 = nm[0][0], m12 = nm[1][0], m13 = nm[2][0];
  const m21 = nm[0][1], m22 = nm[1][1], m23 = nm[2][1];
  const m31 = nm[0][2], m32 = nm[1][2], m33 = nm[2][2];

  const tr = m11 + m22 + m33;
  let q: [number, number, number, number] = [0, 0, 0, 1];

  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1.0);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  return quatNormalize(q);
};

export function getConnectedGroup(connections: ConnectionGraph, startId: string, excludeId: string): string[] {
  const visited = new Set<string>();
  const queue = [startId];
  visited.add(startId);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = connections[current];
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor) && neighbor !== excludeId) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }
  return Array.from(visited);
}

const _history = new HistoryStack(50);

/**
 * 全局 hoveredPort 清空定时器：handlePointerOut 触发的"清空"通过它推迟 80ms 生效。
 *
 * 为什么必须做这层防抖：
 *  1. R3F 的 group 在内部子 mesh（PortArrow 里 sphere ↔ cylinder hitbox）之间转移指针时，
 *     会先冒泡 pointerout、再冒泡 pointerover。指针根本没离开 group 也会刷出 out/in 串。
 *  2. 用户从端口 A 移到端口 B，A 的 out 和 B 的 over 是两次独立调用：如果 A 在 PortArrow
 *     本地防抖，定时器到期后会写入 null，盖掉 B 已经写入的 hoveredPort，导致幽灵闪没。
 *  3. PlacementGhost 直接订阅 hoveredPort，一旦它变 null 就 unmount，伴随 InteractivePart
 *     重挂载、整组渲染、视觉上肉眼可感的闪烁。
 *
 * 把防抖做在 store 这一层后，全局只有一个待决 null：任何 port 的非空 hover 进来都能
 * 一键 cancel 掉，hoveredPort 在端口之间平滑切换；只有指针真正离开所有端口 80ms 才会清空。
 */
let _hoveredPortClearTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// 持久化 schema（issue #64 #4）
// ---------------------------------------------------------------------------
// 旧实现：partialize 手写白名单 + 没有任何编译时校验，新加 store 字段时
// 漏更新 → reload 后悄悄丢失，无报错。
//
// 新实现：把所有 state 字段强制分类到 PERSISTED 或 TRANSIENT 两个 const
// tuple；用类型层面 _ExhaustiveStateClassification 断言两 tuple 之并集
// 覆盖全部 state 字段。新加 state 字段未分类 → tsc 编译失败，强制做决策。
// Actions（函数签名）通过 utility 类型自动过滤，不参与分类。

/** 持久化字段名单 — partialize 输出包含这些字段。新增持久化字段在此处加。 */
const PERSISTED_FIELD_KEYS = [
  'parts',
  'connections',
  'occupiedPorts',
  'activeColorCode',
  'cameraTarget',
  'partUsages',
  'hiddenParts',
] as const satisfies readonly (keyof StoreState)[];

type PersistedFieldKey = typeof PERSISTED_FIELD_KEYS[number];

/** 显式 transient state 字段名单 — 不参与持久化，reload 后回 initialState。
 *  新加 state 字段时若不打算持久化，必须在此追加，否则编译失败。 */
const TRANSIENT_STATE_FIELD_KEYS = [
  'mode',
  'modeToggleError',
  'modeToggling',
  'view',
  'wsConnected',
  'selectedPort',
  'hoveredPort',
  'slidingTarget',
  'interactionPhase',
  'focusedPartId',
  'focusMode',
  'showPortGizmos',
  'enableFocusAnimation',
  'enableSSAO',
  'enableContactShadows',
  'debugMode',
  'debugShowPorts',
  'isPortModifierHeld',
  'marqueeBox',
  'previewPartId',
  'canUndo',
  'canRedo',
  'stagingGrid',
  'snapPreState',
  'continuousPlacementSource',
  'logs',
  'showLogPanel',
  'isContextLost',
  'isSearchOpen',
  'portSelectionLevel',
  'lastSnapPairCount',
  'predictedSnapPairCount',
  'selection',
  'clipboard',
  'freePlacingPayload',
  'freePlacingPointer',
  'freePlacingProjectionMode',
  'freePlacingMeta',
  'interferenceReport',
  'slideOffset',
  'partCatalog',
  'reactionForces',
  'showReactionForces',
] as const satisfies readonly (keyof StoreState)[];

/** 仅 state 字段名（过滤掉 actions —— value 是函数则排除）。 */
type StateFieldKey = {
  [K in keyof StoreState]: StoreState[K] extends (...args: never[]) => unknown ? never : K
}[keyof StoreState];

/** 编译期完备性 — 每个 state 字段必须分类到 PERSISTED 或 TRANSIENT。
 *  新加未分类字段 → 此类型解析为 never → 下面 const 赋值 true 编译失败。 */
type _ExhaustiveStateClassification = StateFieldKey extends
  PersistedFieldKey | typeof TRANSIENT_STATE_FIELD_KEYS[number] ? true : never;
const _verifyExhaustiveStateClassification: _ExhaustiveStateClassification = true;
void _verifyExhaustiveStateClassification;

/** partialize 输出形状 — 把 PERSISTED 字段映射到序列化形式。
 *  Set 字段（hiddenParts）转 Array；ConnectionGraph 把 Set 内层转 Array。
 *  其它原样透传。
 *
 *  这里类型仍写运行时形（Set / ConnectionGraph）是 zustand persist 类型
 *  约束兜底；merge() 函数承担反序列化职责。 */
type PersistShape = {
  parts: StoreState['parts'];
  connections: ConnectionGraph;
  occupiedPorts: StoreState['occupiedPorts'];
  activeColorCode: StoreState['activeColorCode'];
  cameraTarget: StoreState['cameraTarget'];
  partUsages: StoreState['partUsages'];
  hiddenParts: StoreState['hiddenParts'];
};

/** partialize 输出构造器。返回类型 PersistShape 钉死字段集合：漏字段
 *  tsc 红；多字段 satisfies 红。两道闸保证 partialize 输出 == 持久化白名单。 */
function persistShape(state: StoreState): PersistShape {
  return {
    parts: state.parts,
    connections: Object.fromEntries(
      Object.entries(state.connections).map(([k, v]) => [k, Array.from(v)])
    ) as unknown as ConnectionGraph,
    occupiedPorts: state.occupiedPorts,
    activeColorCode: state.activeColorCode,
    cameraTarget: state.cameraTarget,
    partUsages: state.partUsages,
    hiddenParts: Array.from(state.hiddenParts) as unknown as Set<string>,
  } satisfies Record<PersistedFieldKey, unknown>;
}

/** 测试 / debug 用 — 暴露持久化字段清单做断言。 */
export const __persistFieldsForTest: readonly PersistedFieldKey[] = PERSISTED_FIELD_KEYS;

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
  mode: 'ASSEMBLY',
  modeToggleError: null,
  modeToggling: false,
  view: 'EDITOR',
  parts: {},
  connections: {},
  occupiedPorts: {},
  wsConnected: false,
  selectedPort: null,
  hoveredPort: null,
  slidingTarget: null,
  interactionPhase: InteractionPhase.IDLE,
  focusedPartId: null,
  focusMode: null,
  showPortGizmos: true,
  enableFocusAnimation: true,
  enableSSAO: true,
  enableContactShadows: true,
  debugMode: false,
  debugShowPorts: false,
  isPortModifierHeld: false,
  marqueeBox: null,
  previewPartId: null,
  canUndo: false,
  canRedo: false,
  stagingGrid: new StagingGrid(),
  snapPreState: null,
  continuousPlacementSource: null,

  // 全局活跃颜色码，默认为 4 (Red)，供新建零件实例时使用
  activeColorCode: 4,
  
  logs: [],
  showLogPanel: false,
  isContextLost: false,
  isSearchOpen: false,
  portSelectionLevel: SelectionLevel.INDIVIDUAL,
  lastSnapPairCount: 0,
  predictedSnapPairCount: null,

  selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
  clipboard: [],
  freePlacingPayload: [],
  freePlacingPointer: null,
  freePlacingMeta: null,
  freePlacingProjectionMode: FreePlacingProjectionMode.SCENE_RAYCAST,
  hiddenParts: new Set(),
  interferenceReport: { isBlocked: false, blockingPartId: null, contactPoints: [], reason: null },
  slideOffset: 0,
  cameraTarget: null,
  partUsages: {},
  partCatalog: {},
  reactionForces: {},
  showReactionForces: false,

  setPartCatalog: (catalog) => set({ partCatalog: catalog }),
  setShowReactionForces: (v) => set({ showReactionForces: v }),
  refreshReactionForces: async () => {
    try {
      const res = await axios.post(`${API_URL}/api/compute_reactions`);
      type RawStress = {
        axial_force_N: number;
        shear_force_N: number;
        normal_stress_pa: number;
        shear_stress_pa: number;
        von_mises_pa: number;
        safety_ratio: number;
        yields: boolean;
      };
      const data = res.data as { status?: string; reactions?: Record<string, {
        parent_id: string;
        child_id: string;
        anchor_world: [number, number, number];
        force: [number, number, number];
        torque: [number, number, number];
        magnitude_force: number;
        magnitude_torque: number;
        stress?: RawStress | null;
      }> };
      if (data.status !== 'success' || !data.reactions) {
        set({ reactionForces: {} });
        return;
      }
      const out: Record<string, ReactionData> = {};
      for (const [k, v] of Object.entries(data.reactions)) {
        const raw = v.stress;
        out[k] = {
          parentId:        v.parent_id,
          childId:         v.child_id,
          anchorWorld:     v.anchor_world,
          force:           v.force,
          torque:          v.torque,
          magnitudeForce:  v.magnitude_force,
          magnitudeTorque: v.magnitude_torque,
          stress: raw ? {
            axialForceN:    raw.axial_force_N,
            shearForceN:    raw.shear_force_N,
            normalStressPa: raw.normal_stress_pa,
            shearStressPa:  raw.shear_stress_pa,
            vonMisesPa:     raw.von_mises_pa,
            safetyRatio:    raw.safety_ratio,
            yields:         raw.yields,
          } : null,
        };
      }
      set({ reactionForces: out });
    } catch (err) {
      get().addLog(
        `[ReactionForces] 求解失败：${err instanceof Error ? err.message : String(err)}`,
        'ERROR',
      );
      set({ reactionForces: {} });
    }
  },

  reset: () => {
      get().addLog("Store reset to default state.");
      get().stagingGrid.clearAll();
      set({
        parts: {},
        connections: {},
        occupiedPorts: {},
        interactionPhase: InteractionPhase.IDLE,
        selectedPort: null,
        hoveredPort: null,
        selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
        clipboard: [],
        freePlacingPayload: [],
        freePlacingPointer: null,
        freePlacingMeta: null,
        freePlacingProjectionMode: FreePlacingProjectionMode.SCENE_RAYCAST,
        hiddenParts: new Set(),
        interferenceReport: { isBlocked: false, blockingPartId: null, contactPoints: [], reason: null },
        slideOffset: 0,
        cameraTarget: null,
        snapPreState: null,
        continuousPlacementSource: null,
        isContextLost: false
      });
  },

  setView: (view) => {
      get().addLog(`Switching view to: ${view}`);
      set({ view });
  },

  toggleMode: async () => {
    // 修自 issue #63：失败时把 error 暴露到 store 字段供 UI 订阅，不再仅 log 静默。
    // 进行中防双击：modeToggling=true 时早退。
    if (get().modeToggling) return;

    const nextMode = get().mode === 'ASSEMBLY' ? 'SIMULATION' : 'ASSEMBLY';
    get().addLog(`Toggling mode to: ${nextMode}`, 'ACTION');
    set({ modeToggling: true, modeToggleError: null });
    try {
      // 路由与后端 FastAPI 定义保持一致：/api/toggle_mode
      await axios.post(`${API_URL}/api/toggle_mode?mode=${nextMode}`);
      set({
        mode: nextMode,
        selectedPort: null,
        interactionPhase: InteractionPhase.IDLE,
        continuousPlacementSource: null,
        modeToggling: false,
        modeToggleError: null,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      get().addLog(`Failed to toggle mode: ${message}`, 'ERROR');
      set({ modeToggling: false, modeToggleError: message });
    }
  },

  updatePartState: (partId, state) => set((prev) => {
    const part = prev.parts[partId];
    if (!part) return {};
    return { parts: { ...prev.parts, [partId]: { ...part, ...state } } };
  }),

  batchUpdatePartStates: (updates) => set((prev) => {
      const newParts = { ...prev.parts };
      Object.entries(updates).forEach(([id, state]) => {
          if (newParts[id]) newParts[id] = { ...newParts[id], ...state };
      });
      return { parts: newParts };
  }),

  setWsConnected: (status) => {
      if (status !== get().wsConnected) {
          get().addLog(`WebSocket ${status ? 'Connected' : 'Disconnected'}`, status ? 'INFO' : 'ERROR');
      }
      set({ wsConnected: status });
  },
  
  setCameraTarget: (target) => set({ cameraTarget: target }),

  setFocus: ({ partId, mode }) => {
      const msg = partId ? `Focusing on ${partId} (Mode: ${mode})` : "Clearing focus";
      get().addLog(msg);
      set({ focusedPartId: partId, focusMode: mode });
      
      if (partId && get().enableFocusAnimation) {
          const state = get().parts[partId];
          if (state) {
              set({ cameraTarget: [state.position[0], state.position[1], state.position[2]] });
          }
      } else if (!partId) {
          set({ cameraTarget: null });
      }
  },
  
  setShowPortGizmos: (value) => set({ showPortGizmos: value }),
  setEnableFocusAnimation: (value) => set({ enableFocusAnimation: value }),
  setEnableSSAO: (value) => set({ enableSSAO: value }),
  setEnableContactShadows: (value) => set({ enableContactShadows: value }),
  setDebugMode: (value) => {
      get().addLog(`Debug mode: ${value}`);
      set({ debugMode: value });
  },
  setDebugShowPorts: (value) => set({ debugShowPorts: value }),
  // 仅在值变化时 set，避免 keydown/keyup 高频重复触发订阅者重渲染。
  setPortModifierHeld: (value) => {
    if (get().isPortModifierHeld !== value) set({ isPortModifierHeld: value });
  },
  setPartZone: (partId, zone) => get().updatePartState(partId, { zone }),

  setActiveColorCode: (code) => {
      get().addLog(`Active color code changed to: ${code}`, 'ACTION');
      set({ activeColorCode: code });
  },

  // 已放置零件改色（UX）：选中件 → 点调色板上色。作用 selection.allConnectedIds；
  // 功能预设色件（销/轴）跳过；可撤销。
  recolorSelected: (code) => {
    const { selection, parts, batchUpdatePartStates } = get();
    const ids = selection.allConnectedIds.length > 0
      ? selection.allConnectedIds
      : (selection.primaryId ? [selection.primaryId] : []);
    if (ids.length === 0) return;

    const prevColors: Record<string, Partial<PartState>> = {};
    const nextColors: Record<string, Partial<PartState>> = {};
    let lockedCount = 0;
    ids.forEach(id => {
      const p = parts[id];
      if (!p) return;
      if (hasPresetColor(p.ldrawId)) { lockedCount++; return; } // 预设色件锁定
      if (p.colorCode === code) return; // 已是该色，免命令
      prevColors[id] = { colorCode: p.colorCode };
      nextColors[id] = { colorCode: code };
    });

    const changed = Object.keys(nextColors).length;
    if (changed === 0) {
      if (lockedCount > 0) get().addLog(`选中件为功能预设色（销/轴等），颜色锁定不可改`, 'INFO');
      return;
    }

    const applyFn = () => batchUpdatePartStates(nextColors);
    const revertFn = () => batchUpdatePartStates(prevColors);
    const emptySnap: TopologySnapshot = {
      addedParts: {}, removedParts: {}, addedConnections: [], removedConnections: [],
    };
    const cmd = createTopologyCommand('TRANSFORM', emptySnap, applyFn, revertFn);
    applyFn();
    _history.push(cmd);
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
    const lockNote = lockedCount > 0 ? `（${lockedCount} 件功能预设色已跳过）` : '';
    get().addLog(`改色 LDraw #${code}：${changed} 件${lockNote}`, 'ACTION');
  },

  undo: () => {
    // 修：snap 已落但尚未 commit（AXIAL_SLIDING 中，snapPreState 非空）时，
    // 该 snap 还没进 _history。此刻 Cmd+Z 的直觉是"撤掉我刚做的这步 snap"，
    // 而不是去翻更早的已提交命令——后者会让旧操作被撤、当前 snap 还挂着，
    // 状态错位（用户反馈"Cmd+Z 不好用"的真因）。abortCurrentInteraction 用
    // 同一套 snapPreState 逻辑干净回退当前 snap 并复位到 IDLE。
    if (get().snapPreState) {
      get().abortCurrentInteraction();
      return;
    }
    _history.undo();
    get().addLog("Undo performed", 'ACTION');
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
  },

  redo: () => {
    // 进行中的 snap（snapPreState 非空）期间 redo 无意义：当前这步还没落历史，
    // redo 翻出的是更早被 undo 的命令，会跟 live snap 打架。直接忽略。
    if (get().snapPreState) return;
    _history.redo();
    get().addLog("Redo performed", 'ACTION');
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
  },

  handlePortClick: async (port: SelectedPortInfo) => {
    const { interactionPhase, snapParts, parts } = get();
    get().addLog(`Port clicked: ${port.partId} (${port.ldrawId})`, 'ACTION');

    // 如果当前正在滑动，任意点击都应先静默提交滑动状态。
    // ⚠ 连续放置模式下 commitAxialSliding 会用新 instanceId 覆盖 store.selectedPort，
    // 因此 selectedPort 必须在 commit 之后再读取（见下方 `const selectedPort = get()...`），
    // 不能提前解构成本地常量——否则下一次 snap 会拿着旧 partId 命中 parts[oldId] 已存在
    // 分支，把同一根销从 hole #1 拖到 hole #2（视觉上呈"前一根销消失"）。
    if (interactionPhase === InteractionPhase.AXIAL_SLIDING) {
      get().commitAxialSliding();
    }
    const selectedPort = get().selectedPort;

    const activeParts = Object.values(parts).filter(p => p.zone === ZoneType.ACTIVE_ARENA);
    if (activeParts.length === 0 && (interactionPhase === InteractionPhase.IDLE || interactionPhase === InteractionPhase.PREVIEWING)) {
      get().addLog(`Starting first part in scene: ${port.partId}`);
      const instanceId = port.partId;
      // 颜色决策：字典预设色 > 画笔色（activeColorCode）
      const initialColorCode = getDefaultColorCode(
        port.ldrawId || port.partId,
        get().activeColorCode
      );
      set((state) => ({
        parts: {
          ...state.parts,
          [instanceId]: {
            ldrawId: port.ldrawId || instanceId.split('_')[0],
            position: [0, 0, 0] as Vec3,
            quaternion: [0, 0, 0, 1] as Quat,
            colorCode: initialColorCode,
            zone: ZoneType.ACTIVE_ARENA
          }
        },
        interactionPhase: InteractionPhase.IDLE,
        previewPartId: null,
        selectedPort: null
      }));
      return;
    }

    // 现在 interactionPhase 可能是 IDLE (如果刚才由于提交而转为 IDLE)
    const currentPhase = get().interactionPhase;
    if (currentPhase === InteractionPhase.IDLE || currentPhase === InteractionPhase.PREVIEWING) {
      get().addLog(`Source port locked: ${port.partId}`);
      set({ 
        selectedPort: port, 
        interactionPhase: InteractionPhase.SOURCE_LOCKED, 
        previewPartId: null,
        continuousPlacementSource: port.isFromPreview ? port : null // 开启连续放置模式
      });
      return;
    }
    if (currentPhase === InteractionPhase.SOURCE_LOCKED && selectedPort) {
      if (port.partId === selectedPort.partId) {
        get().addLog("Clicked another port on same part, switching source.");
        set({ selectedPort: port }); // 切换源端口，不中止
        return;
      }
      get().addLog(`Target port selected: ${port.partId}. Starting snap animation...`, 'PHYSICS');
      
      const { connections, parts } = get();
      const srcGroup = getConnectedGroup(connections, selectedPort.partId, port.partId);
      const prevPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
      const addedPartIds: string[] = [];
      srcGroup.forEach(pid => {
        const p = parts[pid];
        if (p) prevPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
        else addedPartIds.push(pid);
      });

      const srcPortKey = portKey(selectedPort.position, selectedPort.rotation);
      const tgtPortKey = portKey(port.position, port.rotation);
      set({
        interactionPhase: InteractionPhase.ANIMATING_SNAP,
        snapPreState: {
          movedPartIds: srcGroup,
          prevPositions,
          addedConnections: [{ from: selectedPort.partId, to: port.partId }],
          addedPartIds,
          addedPortKeys: [
            { partId: selectedPort.partId, key: srcPortKey, peerId: port.partId },
            { partId: port.partId,        key: tgtPortKey, peerId: selectedPort.partId },
          ],
        }
      });

      const ok = await snapParts(selectedPort, port);
      
      if (ok) {
          get().addLog("Snap SUCCESSFUL. Entering Axial Sliding...", 'PHYSICS');
          set({ 
            interactionPhase: InteractionPhase.AXIAL_SLIDING,
            slidingTarget: port,
            slideOffset: 0
          });
      } else {
          get().addLog("Snap FAILED.", 'ERROR');
          set({ interactionPhase: InteractionPhase.IDLE, selectedPort: null, hoveredPort: null });
      }
    }
  },

  setHoveredPort: (port) => {
    const { interactionPhase, continuousPlacementSource, hoveredPort: prevHovered } = get();
    const inActivePhase = interactionPhase === InteractionPhase.SOURCE_LOCKED ||
       (interactionPhase === InteractionPhase.AXIAL_SLIDING && continuousPlacementSource);

    if (!inActivePhase) {
      // 离开有效阶段时（如 IDLE），同样要把可能挂着的延时清掉，避免它在 IDLE 下意外清空状态
      if (_hoveredPortClearTimer) {
        clearTimeout(_hoveredPortClearTimer);
        _hoveredPortClearTimer = null;
      }
      if (get().hoveredPort !== null) set({ hoveredPort: null });
      return;
    }

    if (port) {
      // 非空写入：立刻生效，并撤销任何待决的 null 清空（端口 A→B 切换的兜底）
      if (_hoveredPortClearTimer) {
        clearTimeout(_hoveredPortClearTimer);
        _hoveredPortClearTimer = null;
      }
      if (!prevHovered || prevHovered.partId !== port.partId) {
        get().addLog(`[Port HOVER] hoveredPort -> ${port.partId} @ ${port.portType}`, 'INFO');
      }
      set({ hoveredPort: port });
      return;
    }

    // 空写入：推迟 300ms 生效。窗口内只要有任何 PortArrow 的 over 进来都会取消这次清空。
    // 选 300ms 是因为：
    //  - 80ms 只够吞 R3F group 内部 sphere↔cylinder 切换的瞬时 out/in；
    //  - 用户在多个候选孔之间移动鼠标时，会有 ~几百 ms 的"短暂离开所有 port hitbox 看下一个"，
    //    用 300ms 才能撑过这段视觉空窗，让 ghost 保持稳定不闪。
    //  - 真正离开（鼠标移到画面别处 / 长时间静止在非 port 区域）时 300ms 的延迟感官上可接受。
    if (_hoveredPortClearTimer) clearTimeout(_hoveredPortClearTimer);
    _hoveredPortClearTimer = setTimeout(() => {
      _hoveredPortClearTimer = null;
      if (get().hoveredPort) {
        get().addLog(`[Port HOVER] hoveredPort -> null`, 'INFO');
        set({ hoveredPort: null });
      }
    }, 300);
  },

  snapParts: async (source, target, slideOffset = 0, shiftKey = false) => {
    const { parts, connections, stagingGrid, occupiedPorts } = get();
    const targetPart = parts[target.partId];
    if (!targetPart || targetPart.zone !== ZoneType.ACTIVE_ARENA) return false;
    // 修自 issue #66：calculateClampedOffset 在生产路径接通。
    // 默认 limit 8 LDU；shiftKey=true 时屏蔽限位（穿模）。
    // 之前 calculateClampedOffset 仅在 snapMath.test 单测中被调用，源码 import
    // 但从未触达 snap pipeline，导致用户拖动可任意穿透障碍。
    const effectiveOffset = calculateClampedOffset(slideOffset, shiftKey);

    const srcGroup = getConnectedGroup(connections, source.partId, target.partId);
    let sourcePart = parts[source.partId] || {
      ldrawId: source.ldrawId, position: [0, 0, 0] as Vec3, quaternion: [0, 0, 0, 1] as Quat, colorCode: getDefaultColorCode(source.ldrawId || source.partId, get().activeColorCode), zone: ZoneType.ACTIVE_ARENA
    };

    const prevPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
    srcGroup.forEach(pid => {
      const p = parts[pid];
      if (p) prevPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
    });

    const { position, quaternion } = calculateSnapPose(
      source.position as Vec3,
      getQuatFromMat3(source.rotation as Mat3),
      target.globalPos as Vec3,
      (target.globalQuat || [0, 0, 0, 1]) as Quat, // 增加安全回退
      effectiveOffset
    );

    // 刚体组吸附：把 source 的位姿位移作为 delta，整体施加给整个 srcGroup。
    // 这样灰板上插了销、销又被点为 source 时，灰板会跟着销一起飞过去，而不是
    // 把销自己拽走、把灰板留在原地导致连接图与几何状态撕裂。
    const oldSourcePose = parts[source.partId]
      ? { position: parts[source.partId].position, quaternion: parts[source.partId].quaternion }
      : { position: [0, 0, 0] as Vec3, quaternion: [0, 0, 0, 1] as Quat };
    const newSourcePose = { position, quaternion };
    const groupNewPoses = applyGroupDelta(
      srcGroup, parts, source.partId, oldSourcePose, newSourcePose
    );

    // ── L44 齿轮咬合相位对齐 ─────────────────────────────────────────────
    // 在 srcGroup 各成员的新位姿基础上，扫描场景里其他齿轮，找到平行轴 +
    // 距离匹配 (T_a+T_b)/2 module 的潜在 mesh partner，把成员绕自身 Z 轴
    // 转到"齿尖指向 partner"的最小角度。partner 限定在 srcGroup 之外
    // 避免 group 内自我咬合（同一组里的多齿轮通常共轴或几何上不可能 mesh）。
    const partCatalog = get().partCatalog;
    const groupSet = new Set(srcGroup);
    // 候选：场景里非 group 成员的所有齿轮（齿数已知）
    const candidates: GearPart[] = [];
    Object.entries(parts).forEach(([pid, pst]) => {
      if (groupSet.has(pid)) return;
      const meta = partCatalog[pst.ldrawId];
      if (!meta?.toothCount) return;
      candidates.push({
        partId: pid, ldrawId: pst.ldrawId,
        position: pst.position, quaternion: pst.quaternion,
        toothCount: meta.toothCount,
      });
    });
    // 对 group 中每个有齿数的零件，查 mesh partner 并应用 phase
    Object.keys(groupNewPoses).forEach(pid => {
      const pst = parts[pid];
      // source 可能是新建零件还没在 parts 里：用 sourcePart 兜底
      const ldrawId = pst?.ldrawId ?? (pid === source.partId ? sourcePart.ldrawId : null);
      if (!ldrawId) return;
      const meta = partCatalog[ldrawId];
      if (!meta?.toothCount) return;
      const pose = groupNewPoses[pid];
      const sourceGear: GearPart = {
        partId: pid, ldrawId,
        position: pose.position, quaternion: pose.quaternion,
        toothCount: meta.toothCount,
      };
      const result = findMeshPartnerAndDelta(sourceGear, candidates);
      if (!result || Math.abs(result.delta) < 1e-9) return;
      const newQuat = rotateGearAroundOwnAxis(pose.quaternion, result.delta);
      groupNewPoses[pid] = { position: pose.position, quaternion: newQuat };
      get().addLog(
        `[GearMesh] ${pid} (T=${meta.toothCount}) ↔ ${result.partner.partId} ` +
        `(T=${result.partner.toothCount})：相位偏移 ${(result.delta * 180 / Math.PI).toFixed(2)}°`,
        'INFO',
      );
    });

    const updated: Record<string, PartState> = { ...parts };
    // 兜底：source 若是 preview 新建零件，parts 里还没条目，需要先把 sourcePart 落进去
    if (!parts[source.partId]) {
      updated[source.partId] = {
        ...sourcePart,
        position: position as Vec3,
        quaternion: quaternion as Quat,
        zone: ZoneType.ACTIVE_ARENA,
      };
    }
    Object.entries(groupNewPoses).forEach(([pid, pose]) => {
      const cur = updated[pid];
      if (!cur) return;
      updated[pid] = {
        ...cur,
        position:   pose.position   as Vec3,
        quaternion: pose.quaternion as Quat,
        zone: ZoneType.ACTIVE_ARENA,
      };
    });

    stagingGrid.releaseSlot(source.partId);

    const newConnections = { ...connections };
    [source.partId, target.partId].forEach(id => { if (!newConnections[id]) newConnections[id] = new Set(); });
    newConnections[source.partId].add(target.partId);
    newConnections[target.partId].add(source.partId);

    // 端口级占用同步：本次 Snap 把 source/target 两个端口都"塞住"。
    // 渲染层据此隐藏被占用的端口（例如插销插入孔后，原孔不再可拾取），
    // 修复"误点已占用孔→源极性变成同性→悬停目标无幽灵"的体验 Bug。
    const srcKey = portKey(source.position, source.rotation);
    const tgtKey = portKey(target.position, target.rotation);
    const newOccupied: OccupiedPortMap = { ...occupiedPorts };
    newOccupied[source.partId] = { ...(newOccupied[source.partId] || {}), [srcKey]: target.partId };
    newOccupied[target.partId] = { ...(newOccupied[target.partId] || {}), [tgtKey]: source.partId };

    // History recording is now handled in commitAxialSliding to allow for proper undo/redo of the sliding action

    // 先更新本地状态，保证 UI 立即响应（乐观更新）
    set({ parts: updated, connections: newConnections, occupiedPorts: newOccupied });

    // ── v3.1：异步通知后端登记拓扑并触发 Auto-Latch ──────────────────────────
    // 降级策略：后端调用失败不影响前端已完成的本地连接（与 server.py 中 AutoLatch
    // 异常处理策略保持对称）。
    // parent 为目标零件（静止基准），child 为被吸附的源零件（刚发生位移）。
    const snapPayload = {
      parent_id: target.partId,
      child_id:  source.partId,
      port_type_p: target.portType,
      port_type_c: source.portType,
      parent_origin: target.globalPos,
      parent_rot:    (target.rotation as number[]).flat ? (target.rotation as number[][]).flat() : target.rotation,
      child_origin:  position,        // Snap 后的最终 SI 世界坐标
      child_rot:     (source.rotation as number[]).flat ? (source.rotation as number[][]).flat() : source.rotation,
      // v3.1 字段：世界坐标，用于 AutoLatchScanner 的 Site 距离筛选
      parent_world_pos: target.globalPos,
      child_world_pos:  position,
      // v4.0 / L45：原始 LDraw .dat 文件名 ——后端 urdf_exporter 据此查 tooth_count
      // 决定是否在导出 URDF 时给该齿轮 joint 加 <mimic>。
      parent_ldraw_id: targetPart?.ldrawId ?? target.ldrawId,
      child_ldraw_id:  sourcePart.ldrawId,
    };

    // 每次 snap 调用生成一个 UUID 作为 Idempotency-Key：浏览器/代理层若发生
    // 网络层重发，后端中间件靠该 key 识别为重放，直接回放上次响应而不再向
    // MultiDiGraph 追加重复边（详见 backend/idempotency.py）。
    const idemKey = crypto.randomUUID();
    axios.post(`${API_URL}/api/snap_parts`, snapPayload, {
      headers: { 'Idempotency-Key': idemKey },
    }).then((res) => {
      const data = res.data as {
        auto_latched_count?: number;
        auto_latched_edges?: Array<{
          src_part_id: string;
          dst_part_id: string;
          src_port_key: string;
          dst_port_key: string;
        }>;
      };
      const edges = data.auto_latched_edges ?? [];
      const autoLatched = data.auto_latched_count ?? 0;
      const totalPairs = 1 + autoLatched;  // 主连接 + Auto-Latch 附加

      // B.3-3 UX 提示：snap 总 pair 数写入 store，StatusBar 据此显
      // "Last snap: N pairs"。常态单点 snap 仍写 1（用户看见 = 1 表示无
      // Auto-Latch，知道这是单点；> 1 表示后端帮把 plug 整片闭合）。
      set({ lastSnapPairCount: totalPairs });

      if (autoLatched > 0) {
        // 当前 snap 是 plug-snap（多 pair）— 用 [PlugSnap] 前缀让 LogPanel
        // 醒目，跟单点 [AutoLatch] 区分
        get().addLog(
          `[PlugSnap] Snap(${source.partId} ↔ ${target.partId}): ${totalPairs} port pairs (1 main + ${autoLatched} auto-latched).`,
          'ACTION'
        );
      }
      if (edges.length === 0) return;

      // ── AutoLatch 边集回流 ────────────────────────────────────────────────
      // 把后端 AutoLatch 闭合的对扣边并入本地 connections + occupiedPorts。
      // 修复 docs/04_quality_and_testing/01_issue_reports.md §3 Open Item #1
      // (旋转锚点查询命中率退化为 anchor=none)。
      //
      // 选型：把 AutoLatch 边追加到当前 snapPreState (方案 a)，而非另起一条
      // follow-up 命令 (方案 b)。理由：用户视角下"插一颗销 + 后端闭合的对扣
      // 边"是单一原子动作，undo 应一次性回滚整组；分两条命令需要两次 ctrl+Z，
      // 破坏心智模型。
      //
      // 罕见竞态：用户在 axios.then 之前就触发 commitAxialSliding（snapPreState
      // 已被消费为 SnapCommand 后置 null）。此时退化为"只更新当前状态、不进入
      // undo 栈"——AutoLatch 边在状态里持续存在 (功能正确)，仅丢失专属撤销步骤；
      // 用户后续删除任一相关零件时仍会通过 stagePart/deletePart 的级联清理走
      // 正常路径。
      //
      // 幂等性：写入前检查 connections.has(peer) 与 occupiedPorts[id][key] 是否
      // 已存在；只把"真正新增"的项追加到 snapPreState，避免与主连接同步写入的
      // 端口键重复。
      set(prev => {
        const nextConn: ConnectionGraph = { ...prev.connections };
        const nextOcc: OccupiedPortMap = { ...prev.occupiedPorts };
        const newAddedConnections: Array<{ from: string; to: string }> = [];
        const newAddedPortKeys: Array<{ partId: string; key: string; peerId: string }> = [];

        for (const e of edges) {
          const a = e.src_part_id, b = e.dst_part_id;
          if (!a || !b) continue;

          const sa = new Set<string>(nextConn[a] ?? []);
          const sb = new Set<string>(nextConn[b] ?? []);
          const wasNewEdge = !sa.has(b);
          sa.add(b);
          sb.add(a);
          nextConn[a] = sa;
          nextConn[b] = sb;
          if (wasNewEdge) {
            newAddedConnections.push({ from: a, to: b });
          }

          const aPorts = { ...(nextOcc[a] ?? {}) };
          const bPorts = { ...(nextOcc[b] ?? {}) };
          const wasNewSrcPort = aPorts[e.src_port_key] === undefined;
          const wasNewDstPort = bPorts[e.dst_port_key] === undefined;
          aPorts[e.src_port_key] = b;
          bPorts[e.dst_port_key] = a;
          nextOcc[a] = aPorts;
          nextOcc[b] = bPorts;
          if (wasNewSrcPort) {
            newAddedPortKeys.push({ partId: a, key: e.src_port_key, peerId: b });
          }
          if (wasNewDstPort) {
            newAddedPortKeys.push({ partId: b, key: e.dst_port_key, peerId: a });
          }
        }

        let nextSnapPreState = prev.snapPreState;
        if (
          nextSnapPreState &&
          (newAddedConnections.length > 0 || newAddedPortKeys.length > 0)
        ) {
          nextSnapPreState = {
            ...nextSnapPreState,
            addedConnections: [
              ...nextSnapPreState.addedConnections,
              ...newAddedConnections,
            ],
            addedPortKeys: [
              ...(nextSnapPreState.addedPortKeys ?? []),
              ...newAddedPortKeys,
            ],
          };
        }

        return {
          connections: nextConn,
          occupiedPorts: nextOcc,
          snapPreState: nextSnapPreState,
        };
      });
    }).catch((err) => {
      // 降级：后端拓扑注册失败，仅记录警告，不撤销前端已建立的本地连接
      get().addLog(
        `[AutoLatch] 后端 snap_parts 调用失败（本地连接已建立）: ${err instanceof Error ? err.message : String(err)}`,
        'ERROR'
      );
    });

    return true;
  },

  abortCurrentInteraction: () => {
    const pre = get().snapPreState;
    if (pre) {
        set(prev => {
            const rp = { ...prev.parts };
            if (pre.addedPartIds) {
                pre.addedPartIds.forEach(id => delete rp[id]);
            }
            Object.entries(pre.prevPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
            const rc = { ...prev.connections };
            pre.addedConnections.forEach(({ from, to }) => {
                if (rc[from]) {
                    const nextSet = new Set(rc[from]);
                    nextSet.delete(to);
                    if (nextSet.size === 0) delete rc[from]; else rc[from] = nextSet;
                }
                if (rc[to]) {
                    const nextSet = new Set(rc[to]);
                    nextSet.delete(from);
                    if (nextSet.size === 0) delete rc[to]; else rc[to] = nextSet;
                }
            });
            const ro: OccupiedPortMap = { ...prev.occupiedPorts };
            // 移除新增的零件携带的占用条目（整张表即将被丢弃）
            if (pre.addedPartIds) {
                pre.addedPartIds.forEach(id => { delete ro[id]; });
            }
            // 撤销 Snap 写入的端口占用条目
            (pre.addedPortKeys || []).forEach(({ partId, key }) => {
                const next = ro[partId];
                if (!next) return;
                const cleaned = { ...next };
                delete cleaned[key];
                if (Object.keys(cleaned).length === 0) delete ro[partId];
                else ro[partId] = cleaned;
            });
            return { parts: rp, connections: rc, occupiedPorts: ro };
        });
    }

    get().addLog("Aborting port interaction.");
    set({
      interactionPhase: InteractionPhase.IDLE,
      selectedPort: null,
      hoveredPort: null,
      slidingTarget: null,
      slideOffset: 0,
      snapPreState: null,
      continuousPlacementSource: null,
      // B.2：abort 复位 plug 选择模式，下一次交互回 PORT 默认
      portSelectionLevel: SelectionLevel.INDIVIDUAL,
      // B.3-3：abort 清最近 snap 计数，StatusBar 不再显示陈旧值
      lastSnapPairCount: 0,
      // B.3-extension：abort 清 hover 预览（hoveredPort 已被清，预览也无意义）
      predictedSnapPairCount: null,
    });
  },

  addLog: (message, type = 'INFO') => set(s => {
      // 连续相同（message+type）折叠：不再 push 新条目，把末条 count +1 并刷新
      // 时间戳。防过约束锁死等高频重复日志刷屏（用户反馈：8+ 条同样的错误墙）。
      const last = s.logs[s.logs.length - 1];
      if (last && last.message === message && last.type === type) {
          const collapsed = { ...last, count: (last.count ?? 1) + 1, timestamp: Date.now() };
          return { logs: [...s.logs.slice(0, -1), collapsed] };
      }
      return { logs: [...s.logs, { timestamp: Date.now(), type, message }].slice(-200) };
  }),

  clearLogs: () => set({ logs: [] }),
  toggleLogPanel: (show) => set(s => ({ showLogPanel: show !== undefined ? show : !s.showLogPanel })),
  
  setContextLost: (lost: boolean) => {
      get().addLog(`WebGL Context ${lost ? 'Lost' : 'Restored'}`, lost ? 'ERROR' : 'INFO');
      set({ isContextLost: lost });
  },

  setSearchOpen: (open: boolean) => set({ isSearchOpen: open }),

  setPortSelectionLevel: (level: SelectionLevel) => set({ portSelectionLevel: level }),

  deleteSelected: () => {
    const { parts, connections, selection, occupiedPorts } = get();
    const idsToDelete = selection.allConnectedIds;
    if (idsToDelete.length === 0) return;

    const removedParts: Record<string, PartState> = {};
    const removedConns: Array<{ from: string; to: string }> = [];

    idsToDelete.forEach(id => {
      if (parts[id]) {
        removedParts[id] = parts[id];
        if (connections[id]) {
          connections[id].forEach(target => {
            if (!removedConns.find(c => (c.from === target && c.to === id) || (c.from === id && c.to === target))) {
              removedConns.push({ from: id, to: target });
            }
          });
        }
      }
    });

    // 收集被删除一方触及的占用条目（自身全部 + 对端指向被删者的反向连接），
    // 全部存入 TopologySnapshot.removedOccupiedPorts 以便撤销时一并恢复。
    const deletedSet = new Set(idsToDelete);
    const removedOccupiedPorts: Record<string, Record<string, string>> = {};
    idsToDelete.forEach(id => {
      const own = occupiedPorts[id];
      if (own && Object.keys(own).length > 0) {
        removedOccupiedPorts[id] = { ...own };
      }
    });
    Object.keys(occupiedPorts).forEach(peerId => {
      if (deletedSet.has(peerId)) return;
      const matched: Record<string, string> = {};
      Object.entries(occupiedPorts[peerId]).forEach(([k, v]) => {
        if (deletedSet.has(v)) matched[k] = v;
      });
      if (Object.keys(matched).length > 0) {
        removedOccupiedPorts[peerId] = matched;
      }
    });

    const snap: TopologySnapshot = {
      addedParts: {}, removedParts,
      addedConnections: [], removedConnections: removedConns,
      removedOccupiedPorts,
    };

    const doRemove = (ids: string[], occToRemove: Record<string, Record<string, string>>) => {
      set(s => {
        const np = { ...s.parts };
        const nc = { ...s.connections };
        ids.forEach(id => {
          delete np[id];
          delete nc[id];
          Object.keys(nc).forEach(target => {
            if (nc[target].has(id)) {
              const nextSet = new Set(nc[target]);
              nextSet.delete(id);
              nc[target] = nextSet;
            }
          });
        });
        const ro: OccupiedPortMap = { ...s.occupiedPorts };
        Object.entries(occToRemove).forEach(([partId, kvs]) => {
          const cur = ro[partId];
          if (!cur) return;
          const cleaned = { ...cur };
          Object.keys(kvs).forEach(k => delete cleaned[k]);
          if (Object.keys(cleaned).length === 0) delete ro[partId];
          else ro[partId] = cleaned;
        });
        // 兜底：被删除零件残留的整张占用表也一并清理（防止 occToRemove 漏算）
        ids.forEach(id => { delete ro[id]; });
        return { parts: np, connections: nc, occupiedPorts: ro };
      });
    };

    const doAdd = (
      pa: Record<string, PartState>,
      conns: Array<{from: string; to: string}>,
      occToRestore: Record<string, Record<string, string>>,
    ) => {
      set(s => {
        const np = { ...s.parts, ...pa };
        const nc = { ...s.connections };
        conns.forEach(c => {
          nc[c.from] = nc[c.from] ? new Set(nc[c.from]) : new Set();
          nc[c.to] = nc[c.to] ? new Set(nc[c.to]) : new Set();
          nc[c.from].add(c.to);
          nc[c.to].add(c.from);
        });
        const ro: OccupiedPortMap = { ...s.occupiedPorts };
        Object.entries(occToRestore).forEach(([partId, kvs]) => {
          ro[partId] = { ...(ro[partId] || {}), ...kvs };
        });
        return { parts: np, connections: nc, occupiedPorts: ro };
      });
    };

    const cmd = createTopologyCommand('DELETE', snap,
      () => doRemove(idsToDelete, removedOccupiedPorts),
      (s) => doAdd(s.removedParts, s.removedConnections, s.removedOccupiedPorts || {})
    );

    doRemove(idsToDelete, removedOccupiedPorts);
    set({ selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] } });
    _history.push(cmd);
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
    get().addLog(`Deleted ${idsToDelete.length} parts.`, 'ACTION');
  },

  detachSelected: () => {
    const { selection, connections, occupiedPorts } = get();
    const ids = selection.allConnectedIds;
    if (ids.length === 0) return;
    const selSet = new Set(ids);

    // 只切「跨选区边界」的边：选中件 a ↔ 未选中件 b。选区内部边保留（去重，每边记一次）。
    const cutEdges: Array<[string, string]> = [];
    ids.forEach(a => {
      const peers = connections[a];
      if (!peers) return;
      peers.forEach(b => { if (!selSet.has(b)) cutEdges.push([a, b]); });
    });
    if (cutEdges.length === 0) {
      get().addLog('选中件与外部无连接，无需脱开。', 'INFO');
      return;
    }

    // 捕获待清除的占用条目（每条边两侧：a 侧 value===b、b 侧 value===a）供 undo 恢复。
    const removedOcc: Record<string, Record<string, string>> = {};
    const collectOcc = (owner: string, peer: string) => {
      const occ = occupiedPorts[owner];
      if (!occ) return;
      Object.entries(occ).forEach(([k, v]) => { if (v === peer) (removedOcc[owner] ??= {})[k] = v; });
    };
    cutEdges.forEach(([a, b]) => { collectOcc(a, b); collectOcc(b, a); });

    const doRemove = () => set(s => {
      const nc = { ...s.connections };
      cutEdges.forEach(([a, b]) => {
        if (nc[a]) { const x = new Set(nc[a]); x.delete(b); if (x.size === 0) delete nc[a]; else nc[a] = x; }
        if (nc[b]) { const y = new Set(nc[b]); y.delete(a); if (y.size === 0) delete nc[b]; else nc[b] = y; }
      });
      const ro: OccupiedPortMap = { ...s.occupiedPorts };
      Object.entries(removedOcc).forEach(([pid, kvs]) => {
        if (!ro[pid]) return;
        const cleaned = { ...ro[pid] };
        Object.keys(kvs).forEach(k => delete cleaned[k]);
        if (Object.keys(cleaned).length === 0) delete ro[pid]; else ro[pid] = cleaned;
      });
      return { connections: nc, occupiedPorts: ro };
    });

    const doAdd = () => set(s => {
      const nc = { ...s.connections };
      cutEdges.forEach(([a, b]) => {
        nc[a] = nc[a] ? new Set(nc[a]) : new Set();
        nc[b] = nc[b] ? new Set(nc[b]) : new Set();
        nc[a].add(b); nc[b].add(a);
      });
      const ro: OccupiedPortMap = { ...s.occupiedPorts };
      Object.entries(removedOcc).forEach(([pid, kvs]) => { ro[pid] = { ...(ro[pid] || {}), ...kvs }; });
      return { connections: nc, occupiedPorts: ro };
    });

    const snap: TopologySnapshot = {
      addedParts: {}, removedParts: {},
      addedConnections: [], removedConnections: cutEdges.map(([a, b]) => ({ from: a, to: b })),
    };
    const cmd = createTopologyCommand('DETACH', snap, doRemove, doAdd);

    doRemove();
    _history.push(cmd);
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
    get().addLog(`脱开 ${cutEdges.length} 个连接。`, 'ACTION');
  },

  copySelected: () => {
    const { parts, selection, connections } = get();
    const idsToCopy = selection.allConnectedIds;
    if (idsToCopy.length === 0) return;

    const clipData = idsToCopy.map(id => ({ id, state: JSON.parse(JSON.stringify(parts[id])) }));
    set({ clipboard: clipData });

    // 组内连接数（两端都在选区内的边）。在「复制」这一刻就反馈，让用户立刻知道
    // 这次复制出来的副本是「连接好的装配」还是「散件」—— 散件的根因往往是源零件
    // 之间从未真正端口吸附（只是视觉上贴在一起），过去无任何日志线索难以排查。
    const copySet = new Set(idsToCopy);
    let intraEdges = 0;
    idsToCopy.forEach(id => {
      const peers = connections[id];
      if (!peers) return;
      peers.forEach(peer => { if (copySet.has(peer)) intraEdges += 1; });
    });
    intraEdges = intraEdges / 2; // 每条边被两端各数一次
    let note = '';
    if (idsToCopy.length > 1) {
      note = intraEdges > 0
        ? `（含 ${intraEdges} 个组内连接，副本将保持连接）`
        : '（这些零件之间无端口连接，副本会是散件）';
    }
    get().addLog(`Copied ${idsToCopy.length} parts${note}.`, 'ACTION');
  },

  pasteClipboard: () => {
    const { clipboard, connections, occupiedPorts } = get();
    if (!clipboard || clipboard.length === 0) return;

    // 计算剪贴板包围盒中心，使得复制出的“幽灵”始终位于鼠标正中央
    let cx = 0, cy = 0, cz = 0;
    clipboard.forEach(clip => {
      cx += clip.state.position[0];
      cy += clip.state.position[1];
      cz += clip.state.position[2];
    });
    cx /= clipboard.length;
    cy /= clipboard.length;
    cz /= clipboard.length;

    // 旧 id → 新实例 id 映射（保连接用）。clipboard 只存零件位姿，组内连接 / 占用
    // 在此从当前 store 重算（避免改持久化的 clipboard 结构），并 remap 到新 id。
    const idMap: Record<string, string> = {};
    clipboard.forEach(clip => {
      idMap[clip.id] = clip.id.split('_')[0] + '_' + window.crypto.randomUUID().substring(0, 8);
    });
    const clipSet = new Set(clipboard.map(c => c.id));

    const payload = clipboard.map(clip => {
      const st = JSON.parse(JSON.stringify(clip.state));
      st.position = [st.position[0] - cx, st.position[1] - cy, st.position[2] - cz];
      st.zone = ZoneType.ACTIVE_ARENA;
      return { id: idMap[clip.id], state: st as PartState };
    });

    // 组内连接（两端都在选区内）→ remap 到新 id，去重。
    const pastedConns: Array<{ from: string; to: string }> = [];
    const seen = new Set<string>();
    clipboard.forEach(clip => {
      const peers = connections[clip.id];
      if (!peers) return;
      peers.forEach(peer => {
        if (!clipSet.has(peer)) return; // 只保留组内边（与组外原件的连接不复制）
        const a = idMap[clip.id], b = idMap[peer];
        const k = [a, b].sort().join('|');
        if (seen.has(k)) return;
        seen.add(k);
        pastedConns.push({ from: a, to: b });
      });
    });

    // 组内端口占用 → remap（端口 local key 不变，只换 owner / peer 的实例 id）。
    const pastedOcc: Record<string, Record<string, string>> = {};
    clipboard.forEach(clip => {
      const occ = occupiedPorts[clip.id];
      if (!occ) return;
      const remapped: Record<string, string> = {};
      Object.entries(occ).forEach(([key, peer]) => {
        if (!clipSet.has(peer)) return;
        remapped[key] = idMap[peer];
      });
      if (Object.keys(remapped).length > 0) pastedOcc[idMap[clip.id]] = remapped;
    });

    set({
      freePlacingPayload: payload,
      freePlacingMeta: { connections: pastedConns, occupied: pastedOcc },
      // 用 GROUND_PLANE（只与 y=0 求交，无视 ContactShadows / Environment 平面 / 已有
      // 零件等场景网格），与 Drop to Ground 一致：幽灵能在整块地面（含中央网格区）自由
      // 滑动。曾用 SCENE_RAYCAST 想让粘贴堆叠到已有件上，但射线会被场景里的面接住，
      // 幽灵进不去中央区域、还会跳高，弊大于利。
      freePlacingProjectionMode: FreePlacingProjectionMode.GROUND_PLANE,
      freePlacingPointer: null,
      interactionPhase: InteractionPhase.FREE_PLACING,
    });
    get().addLog(`Started placing ${payload.length} parts from clipboard.`, 'ACTION');
  },

  startFreePlacing: (ldrawId: string, colorCode: number, options = {}) => {
    const {
      pointer = null,
      projectionMode = FreePlacingProjectionMode.SCENE_RAYCAST,
    } = options;
    const newId = ldrawId.split('.')[0] + '_' + window.crypto.randomUUID().substring(0,8);
    const payload = [{
      id: newId,
      state: {
        ldrawId,
        position: [0, 0, 0] as Vec3,
        quaternion: [0, 0, 0, 1] as Quat,
        colorCode,
        zone: ZoneType.ACTIVE_ARENA
      }
    }];
    set({
      freePlacingPayload: payload,
      freePlacingMeta: null, // 新建单件无组内连接（避免继承上次粘贴的 meta）
      freePlacingPointer: pointer,
      freePlacingProjectionMode: projectionMode,
      interactionPhase: InteractionPhase.FREE_PLACING,
      previewPartId: null // 关掉预览层
    });
    get().addLog(`Started free placing for new part ${ldrawId}.`, 'ACTION');
  },

  commitFreePlacing: (finalStates?: Record<string, PartState>) => {
    const { freePlacingPayload, freePlacingMeta } = get();
    if (!freePlacingPayload || freePlacingPayload.length === 0) return;

    if (!finalStates) {
      // Aborted or cancelled
      set({
        freePlacingPayload: [],
        freePlacingMeta: null,
        freePlacingPointer: null,
        freePlacingProjectionMode: FreePlacingProjectionMode.SCENE_RAYCAST,
        interactionPhase: InteractionPhase.IDLE
      });
      return;
    }

    const addedParts: Record<string, PartState> = {};
    const newIds: string[] = [];
    Object.entries(finalStates).forEach(([id, state]) => {
      addedParts[id] = state;
      newIds.push(id);
    });

    // 粘贴随带的组内连接 + 占用（id 已 remap）。一并建连，让副本保持连接而非散件。
    const pastedConns = freePlacingMeta?.connections ?? [];
    const pastedOcc = freePlacingMeta?.occupied ?? {};

    const snap: TopologySnapshot = { addedParts, removedParts: {}, addedConnections: pastedConns, removedConnections: [] };

    const doAdd = (pa: Record<string, PartState>) => {
      set(s => {
        const np = { ...s.parts, ...pa };
        const nc = { ...s.connections };
        pastedConns.forEach(({ from, to }) => {
          nc[from] = nc[from] ? new Set(nc[from]) : new Set();
          nc[to] = nc[to] ? new Set(nc[to]) : new Set();
          nc[from].add(to);
          nc[to].add(from);
        });
        const ro: OccupiedPortMap = { ...s.occupiedPorts };
        Object.entries(pastedOcc).forEach(([pid, kvs]) => {
          ro[pid] = { ...(ro[pid] || {}), ...kvs };
        });
        return { parts: np, connections: nc, occupiedPorts: ro };
      });
    };
    const doRemove = (ids: string[]) => {
      set(s => {
        const np = { ...s.parts };
        ids.forEach(id => delete np[id]);
        const nc = { ...s.connections };
        pastedConns.forEach(({ from, to }) => {
          if (nc[from]) { const x = new Set(nc[from]); x.delete(to); if (x.size === 0) delete nc[from]; else nc[from] = x; }
          if (nc[to]) { const y = new Set(nc[to]); y.delete(from); if (y.size === 0) delete nc[to]; else nc[to] = y; }
        });
        const ro: OccupiedPortMap = { ...s.occupiedPorts };
        ids.forEach(id => delete ro[id]);
        return { parts: np, connections: nc, occupiedPorts: ro };
      });
    };

    const cmd = createTopologyCommand('PASTE', snap,
      () => doAdd(addedParts),
      () => doRemove(newIds)
    );

    doAdd(addedParts);
    _history.push(cmd);
    set({
      canUndo: _history.canUndo,
      canRedo: _history.canRedo,
      selection: { primaryId: newIds[0], level: SelectionLevel.GROUP, allConnectedIds: newIds, excludedIds: [] },
      freePlacingPayload: [],
      freePlacingMeta: null,
      freePlacingPointer: null,
      freePlacingProjectionMode: FreePlacingProjectionMode.SCENE_RAYCAST,
      interactionPhase: InteractionPhase.IDLE
    });
    const connNote = pastedConns.length > 0 ? `（含 ${pastedConns.length} 个组内连接）` : '';
    get().addLog(`Committed ${newIds.length} parts${connNote}.`, 'ACTION');
  },

  duplicateSelected: () => {
    get().copySelected();
    get().pasteClipboard();
  },

  setHiddenSelected: (hide: boolean) => {
    const { selection, hiddenParts } = get();
    const ids = selection.allConnectedIds;
    if (ids.length === 0) return;
    
    const newHidden = new Set(hiddenParts);
    ids.forEach(id => {
      if (hide) newHidden.add(id);
      else newHidden.delete(id);
    });
    set({ hiddenParts: newHidden });
    get().addLog(`${hide ? 'Hidden' : 'Showed'} ${ids.length} parts.`, 'ACTION');
  },

  showAll: () => {
    set({ hiddenParts: new Set() });
    get().addLog(`Showed all parts.`, 'ACTION');
  },

  selectAll: () => {
    const { parts, hiddenParts } = get();
    const activeIds = Object.keys(parts).filter(k => parts[k].zone === ZoneType.ACTIVE_ARENA && !hiddenParts.has(k));
    set({ 
      selection: { 
        primaryId: activeIds.length > 0 ? activeIds[0] : null, 
        level: SelectionLevel.GROUP, 
        allConnectedIds: activeIds, 
        excludedIds: [] 
      }
    });
    get().addLog(`Selected all ${activeIds.length} visible parts.`, 'ACTION');
  },

  deselectAll: () => {
    set({
      selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] },
      // B.2：deselect 也清 plug 模式，跟 abortCurrentInteraction 行为对齐
      portSelectionLevel: SelectionLevel.INDIVIDUAL,
      // B.3-3：deselect 也清 snap 计数（用户离开当前 commit 上下文）
      lastSnapPairCount: 0,
      // B.3-extension：deselect 清 hover 预览
      predictedSnapPairCount: null,
    });
  },

  setMarqueeSelection: (ids: string[]) => {
    if (ids.length === 0) {
      set({ selection: { primaryId: null, level: SelectionLevel.GROUP, allConnectedIds: [], excludedIds: [] } });
    } else {
      set({ 
        selection: { 
          primaryId: ids[0], 
          level: SelectionLevel.GROUP, 
          allConnectedIds: ids, 
          excludedIds: [] 
        } 
      });
      get().addLog(`Marquee selected ${ids.length} parts.`, 'ACTION');
    }
  },

  setMarqueeBox: (box) => set({ marqueeBox: box }),

  focusCameraOnSelected: () => {
    const { parts, selection } = get();
    const ids = selection.allConnectedIds;
    if (ids.length === 0) return;
    
    let cx = 0, cy = 0, cz = 0;
    let count = 0;
    ids.forEach(id => {
      const p = parts[id];
      if (p) {
        cx += p.position[0];
        cy += p.position[1];
        cz += p.position[2];
        count++;
      }
    });
    if (count > 0) {
      set({ cameraTarget: [cx / count, cy / count, cz / count] });
      get().addLog(`Focused camera on ${count} selected parts.`, 'ACTION');
    }
  },

  addParts: (ids) => set(s => {
    get().addLog(`Add parts to scene: ${ids.join(', ')}`, 'ACTION');
    const np = { ...s.parts };
    const fallback = get().activeColorCode;
    ids.forEach(id => {
      // 颜色决策：字典预设色 > 画笔色（activeColorCode）
      const ldrawId = id.split('_')[0] + '.dat';
      const colorCode = getDefaultColorCode(ldrawId, fallback);
      np[id] = { ldrawId, position: [0,0,0], quaternion: [0,0,0,1], colorCode, zone: ZoneType.ACTIVE_ARENA };
    });
    return { parts: np };
  }),
  removeParts: (ids) => set(s => {
    get().addLog(`Removing parts: ${ids.join(', ')}`, 'ACTION');
    const np = { ...s.parts };
    ids.forEach(id => delete np[id]);
    return { parts: np };
  }),
  connectParts: (a_id, pa, b_id, pb) => set(s => {
    get().addLog(`Establishing connection: ${a_id} <-> ${b_id}`);
    const nc = { ...s.connections };
    if (!nc[a_id]) nc[a_id] = new Set();
    if (!nc[b_id]) nc[b_id] = new Set();
    nc[a_id].add(b_id); nc[b_id].add(a_id);
    return { connections: nc };
  }),
  selectPart: (id, level = SelectionLevel.GROUP, append = false) => {
      get().addLog(`Selecting part: ${id} (Level: ${level}, append: ${append})`, 'ACTION');

      // 主动选中零件「本体」是一个 IDLE 态编辑意图。若此刻仍卡在 SOURCE_LOCKED /
      // AXIAL_SLIDING（端口交互进行中），先中止端口交互回 IDLE，否则 [/] 仍会被
      // 端口旋转路由吃掉（canRotateSelectedPort），整组刚体旋转永远轮不到。
      // 这正是过约束错误提示「点零件本体选中后按 [/]」赖以生效的前提。
      // 注意：吸附目标是点目标「端口」(port dot 独立 click handler)，不走 selectPart，
      // 故此处中止不会破坏 SOURCE_LOCKED → 选目标端口 → snap 的主流程。
      if (id) {
        const phase = get().interactionPhase;
        if (phase === InteractionPhase.SOURCE_LOCKED || phase === InteractionPhase.AXIAL_SLIDING) {
          get().abortCurrentInteraction();
        }
      }

      const prevSelection = get().selection;
      let targetLevel = level;

      let newIds: string[] = [];
      if (id && targetLevel === SelectionLevel.GROUP) {
          newIds = getConnectedGroup(get().connections, id, "");
      } else if (id) {
          newIds = [id];
      }

      let allConnectedIds: string[] = [];
      if (append && id) {
          const currentSet = new Set(prevSelection.allConnectedIds);
          // Toggle mechanics: if all new ones are already in, remove them. Otherwise add them.
          const isAllSelected = newIds.every(n => currentSet.has(n));
          if (isAllSelected) {
              newIds.forEach(n => currentSet.delete(n));
          } else {
              newIds.forEach(n => currentSet.add(n));
          }
          allConnectedIds = Array.from(currentSet);
      } else {
          allConnectedIds = newIds;
      }

      set({ 
          selection: { 
              ...prevSelection, 
              primaryId: append ? (allConnectedIds.length > 0 ? allConnectedIds[allConnectedIds.length - 1] : null) : id, 
              level: targetLevel,
              allConnectedIds
          } 
      });
  },
  updateSelection: (level) => set({ selection: { ...get().selection, level } }),
  updateSlideOffset: (o, shiftKey = false) => {
    const { selectedPort, slidingTarget, snapParts } = get();
    if (selectedPort && slidingTarget) {
      // 修自 issue #66：clamp 在 store 层完成，slideOffset 字段记 clamp 后值，
      // shiftKey 透传给 snapParts 让其内部决定是否走穿模分支。
      const clamped = calculateClampedOffset(o, shiftKey);
      set({ slideOffset: clamped });
      snapParts(selectedPort, slidingTarget, clamped, shiftKey);
    }
  },
  
  rotateSelectedPart: (angleRads: number) => {
    const { parts, selectedPort, slidingTarget, connections, occupiedPorts, batchUpdatePartStates } = get();
    if (!selectedPort) return;

    // The part being rotated is the one that contains the selectedPort.
    const partId = selectedPort.partId;
    const part = parts[partId];
    if (!part) return;

    // Use our utility to calculate new world pose rotated along local Z
    const newPose = calculatePortRotationPose(
        part.position,
        part.quaternion,
        selectedPort.position,
        getQuatFromMat3(selectedPort.rotation),
        angleRads
    );

    // 刚体组旋转的"锚点"语义（对齐 spec：USER_MANUAL §3 旋转作用于"该零件"、
    // Case 3.4 地基不动、Case 4.1 过约束禁旋转、Case 2.2 绕"连接轴"）：
    //
    //   selectedPort 处对面的 peer 视作"地基"，从 source 出发、不穿越 peer
    //   做 BFS 得到 srcGroup，整个 srcGroup 绕 selectedPort 的 Z 轴一起转。
    //
    // 优先级：
    //   1. AXIAL_SLIDING 阶段：slidingTarget.partId 是显式的"对面"，直接排除；
    //   2. SOURCE_LOCKED 阶段：查 occupiedPorts 找 selectedPort 处的 peer，排除它；
    //      这能让"灰板上某孔已接销→红板"时，点灰板转、销和红板都不动。
    //   3. 既无 slidingTarget 也无 peer：source 这一侧没有显式的对面，BFS 不排除任何
    //      节点——此时整个连通组就是 source 自己 + 它已挂的附件，整体旋转是合理的。
    //
    // TODO(Case 4.1 过约束)：若灰板还通过别的孔/别的销并联到 peer 那侧，BFS 绕过
    //   排除节点仍能到达 peer 那一组——此时 srcGroup 会"撕裂式"地把对面也拉进来。
    //   spec 说这种情况应禁用旋转并提示锁死。当前先做基础排除，过约束检测后续补。
    let excludeId = slidingTarget?.partId || "";
    if (!excludeId) {
      // selectedPort 可能是 LDraw connhole 的"对偶面"（同一物理孔在元数据里表达为两个端口：
      //   销从上面插 vs 从下面插，见装配算法规范 §5.1 贯通孔双面分裂），portKey 严格 hash
      //   position+Z 法线 → 用户点哪一面就 key 哪一面，命中不上 snap 时写入的"另一面"。
      //
      // 解决：扫描 occupiedPorts[partId]，找位置在容差内、法线同轴（不论朝向 dot ≈ ±1）的占用项。
      // 阈值 0.02 是从实测数据推出来的：connhole 孔间距 ≈ 0.032、板厚差 ≈ 0.008，0.02 在两者中间。
      const sx = selectedPort.position[0], sy = selectedPort.position[1], sz = selectedPort.position[2];
      const r = selectedPort.rotation as number[][];
      const nz: [number, number, number] = [r[0]?.[2] ?? 0, r[1]?.[2] ?? 0, r[2]?.[2] ?? 0];
      const TOL = 0.02;
      const TOL2 = TOL * TOL;
      const own = occupiedPorts[partId] ?? {};
      for (const [k, v] of Object.entries(own)) {
        const [posPart, normPart] = k.split('|');
        if (!posPart || !normPart) continue;
        const [kx, ky, kz] = posPart.split(',').map(Number);
        const [knx, kny, knz] = normPart.split(',').map(Number);
        const dx = sx - kx, dy = sy - ky, dz = sz - kz;
        if (dx * dx + dy * dy + dz * dz > TOL2) continue;
        const dot = nz[0] * knx + nz[1] * kny + nz[2] * knz;
        if (Math.abs(Math.abs(dot) - 1) > 0.05) continue; // 法线同轴（含反向）
        excludeId = v;
        break;
      }
    }
    const srcGroup = getConnectedGroup(connections, partId, excludeId);

    // Case 4.1 过约束检测（v5：one-hop closure 测试）：
    //   合法旋转域 = {source} ∪ source 的直接邻居（即 source + 挂在它身上的"挂件销/附件"）
    //   srcGroup 必须 ⊆ 合法域；溢出的零件 = source 通过某个邻居二阶到达的"对面物体"，过约束。
    //
    // 比 v4 (cut vertex) 准确：v4 把 degree=1 的"叶子 anchor"误判为过约束（因叶子去掉后 component 数不变）。
    // 比 v3 (邻居漏出) 更全：v3 只看 anchor 直接邻居，漏检"anchor 是挂件 + source 通过别的销连对面"。
    //
    // 既覆盖 spec Case 4.1（"通过 ≥2 个非平行销并联连接 = 锁死"），也兼容 v1/v2 修复场景：
    //   - v1: source=销 (邻居={灰板, 红板}), anchor=红板, srcGroup={销,灰板} ⊆ allowed → 通过 ✓
    //   - v2: source=灰板, srcGroup 包含红板/二阶销 → 溢出 → 过约束 ✓
    //   - 叶子 anchor: source=灰板, srcGroup={灰板} ⊆ allowed → 通过 ✓
    if (excludeId) {
      const sourceNeighbors = connections[partId] || new Set<string>();
      const oneHopAllowed = new Set<string>([partId, ...Array.from(sourceNeighbors)]);
      const overflow = srcGroup.filter(p => !oneHopAllowed.has(p));
      if (overflow.length > 0) {
        get().addLog(
          `[Rot] 过约束锁死：source ${partId} 经其邻居二阶连到 [${overflow.join(', ')}]，端口轴旋转会拽动这些非锚定零件。💡 想整体转：点零件「本体」选中（非端口）后按 [/]，整连通组刚体旋转、不受此约束。否则删多余连接（除 anchor=${excludeId} 外）或换端口作 anchor。（参见 Case 4.1）`,
          'ERROR'
        );
        return;
      }
    }
    const oldSourcePose = { position: part.position, quaternion: part.quaternion };
    const groupNewPoses = applyGroupDelta(srcGroup, parts, partId, oldSourcePose, newPose);

    const updates: Record<string, Partial<PartState>> = {};
    Object.entries(groupNewPoses).forEach(([pid, pose]) => {
      updates[pid] = {
        position:   pose.position   as Vec3,
        quaternion: pose.quaternion as Quat,
      };
    });
    batchUpdatePartStates(updates);
    get().addLog(`Rotated part ${partId} (group of ${srcGroup.length}, anchor=${excludeId || 'none'}) by ${angleRads.toFixed(2)} rads`, 'ACTION');
  },

  // ── 已放置零件自由编辑（IDLE + selection）──────────────────────────────────
  // 选中零件本体后用 [/] 旋转、方向键平移。不依赖端口锁定。整组刚体一起动
  // （getConnectedGroup + applyGroupDelta），可撤销（createTopologyCommand）。
  // 内部 helper：算整组新位姿 + 推可撤销命令 + ACTION 日志。
  _transformSelectedGroup: (newPrimaryPose: { position: Vec3; quaternion: Quat }, logMsg: string) => {
    const { selection, parts, connections, batchUpdatePartStates } = get();
    const primaryId = selection.primaryId;
    const primary = primaryId ? parts[primaryId] : null;
    if (!primaryId || !primary) return;

    const group = getConnectedGroup(connections, primaryId, "");
    const oldPose = { position: primary.position as Vec3, quaternion: primary.quaternion as Quat };
    const groupNewPoses = applyGroupDelta(group, parts, primaryId, oldPose, newPrimaryPose);

    // capture prev / next 供 undo / redo 双向回放
    const prevUpdates: Record<string, Partial<PartState>> = {};
    const nextUpdates: Record<string, Partial<PartState>> = {};
    group.forEach(pid => {
      const p = parts[pid];
      const np = groupNewPoses[pid];
      if (!p || !np) return;
      prevUpdates[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
      nextUpdates[pid] = { position: np.position as Vec3, quaternion: np.quaternion as Quat };
    });

    const applyFn = () => get().batchUpdatePartStates(nextUpdates);
    const revertFn = () => get().batchUpdatePartStates(prevUpdates);
    const emptySnap: TopologySnapshot = {
      addedParts: {}, removedParts: {}, addedConnections: [], removedConnections: [],
    };
    const cmd = createTopologyCommand('TRANSFORM', emptySnap, applyFn, revertFn);

    batchUpdatePartStates(nextUpdates);
    _history.push(cmd);
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
    get().addLog(`${logMsg}（连通组 ${group.length} 个零件）`, 'ACTION');
  },

  rotateSelectedGroup: (angleRads: number) => {
    const { selection, parts } = get();
    const primary = selection.primaryId ? parts[selection.primaryId] : null;
    if (!primary) return;
    // 绕世界 Y 轴；pivot = primary 原点（位置不变，仅旋转）。
    const newQuat = quatTimesAxisAngle(primary.quaternion as Quat, [0, 1, 0], angleRads);
    get()._transformSelectedGroup(
      { position: primary.position as Vec3, quaternion: newQuat },
      `绕 Y 轴旋转 ${(angleRads * 180 / Math.PI).toFixed(0)}°`,
    );
  },

  // Feature A（UX 反馈迭代）：转/移「选中件 + 挂在它上面的子装配」整体（moving 组），
  // 相对「地基」（连通组里最大零件，如大底板，永不跟动）。子装配随动、内部连接恒保持；
  // 只重连评估 moving↔base 界面。几何决策在纯函数 evaluateRotateReconnect；这里组装
  // moving 组刚体位姿 + 装配/拆解 store 状态 + undo + 日志。rotate / translate 共用。
  _transformSelectedSubassembly: (makeNewPrimaryPose, opts) => {
    const { selection, parts, partCatalog, occupiedPorts, connections, batchUpdatePartStates } = get();
    const primaryId = selection.primaryId;
    const part = primaryId ? parts[primaryId] : null;
    if (!primaryId || !part) return;

    const meta = partCatalog[part.ldrawId];
    const bboxCenter = (meta?.bboxCenter ?? null) as Vec3 | null;
    const oldPose: RigidPose = { position: part.position as Vec3, quaternion: part.quaternion as Quat };
    const pivot = worldPivot(oldPose, bboxCenter);

    // 连通组里挑「地基」= 包围盒最大者（大底板 ≫ 小件/插销）。
    const comp = getConnectedGroup(connections, primaryId, "");
    const bboxSizeOf = (pid: string): Vec3 | null => {
      const m = partCatalog[parts[pid]?.ldrawId ?? ''];
      return (m?.bboxSize ?? null) as Vec3 | null;
    };
    const base = pickBasePart(comp, bboxSizeOf);
    // moving 组：从选中件出发、不穿越 base 的连通子集。base===选中件（选中件本身就是
    // 最大/地基）或无 base → moving = 整组（整体刚体动，无界面可重连）。
    const movingFull = (base && base !== primaryId)
      ? getConnectedGroup(connections, primaryId, base)
      : comp;
    // 翻面（keepConnectorsFixed）时：连接件（销/轴/连接器）留在原位充当「连接两部分」，
    // 不随板刚体翻到顶上。选中件自身即便是连接件也参与变换（用户明确要转它）。
    const moving = opts.keepConnectorsFixed
      ? movingFull.filter(id => id === primaryId
          || !isConnectorCategory(partCatalog[parts[id]?.ldrawId ?? '']?.category))
      : movingFull;
    const movingSet = new Set(moving);
    // baseIds = 地基 + （翻面时）被留下的连接件 → 都进重连界面的「不动侧」。
    const baseIds = comp.filter(id => !movingSet.has(id));

    // moving 组目标位姿：选中件按 makeNewPrimaryPose（转/移），其余成员随刚体 delta。
    const newPrimary = makeNewPrimaryPose(oldPose, pivot);
    const movingNewPoses = applyGroupDelta(moving, parts, primaryId, oldPose, newPrimary) as Record<string, RigidPose>;

    const movingOccupied: Record<string, Record<string, string>> = {};
    moving.forEach(id => { if (occupiedPorts[id]) movingOccupied[id] = occupiedPorts[id]; });
    const basePoses: Record<string, RigidPose> = {};
    const baseOccupied: Record<string, Record<string, string>> = {};
    baseIds.forEach(id => {
      const bp = parts[id];
      if (bp) basePoses[id] = { position: bp.position as Vec3, quaternion: bp.quaternion as Quat };
      if (occupiedPorts[id]) baseOccupied[id] = occupiedPorts[id];
    });

    const result = evaluateRotateReconnect({
      movingNewPoses, movingOccupied, basePoses, baseOccupied, autoMove: opts.autoMove,
    });
    const t = result.autoMove;

    // moving 组最终位姿 = 目标位姿 + 整组微移 t（平移时 autoMove=false → t=0）。
    const finalUpdates: Record<string, Partial<PartState>> = {};
    const prevUpdates: Record<string, Partial<PartState>> = {};
    moving.forEach(id => {
      const np = movingNewPoses[id];
      const cur = parts[id];
      if (!np || !cur) return;
      prevUpdates[id] = { position: [...cur.position] as Vec3, quaternion: [...cur.quaternion] as Quat };
      finalUpdates[id] = {
        position: [np.position[0] + t[0], np.position[1] + t[1], np.position[2] + t[2]] as Vec3,
        quaternion: np.quaternion as Quat,
      };
    });

    // ── 捕获脱开界面边的待清除占用条目（供 undo 恢复）。每条边 [m, b]：
    //    m 侧 occupied 里 value===b 的项 + b 侧 occupied 里 value===m 的项。
    const removedOcc: Record<string, Record<string, string>> = {}; // partId → {key: peer}
    const detachedEdges = result.detachedEdges;
    const keptCount = result.keptEdges.length;
    const collectOcc = (owner: string, peer: string) => {
      const occ = occupiedPorts[owner];
      if (!occ) return;
      Object.entries(occ).forEach(([k, v]) => {
        if (v === peer) { (removedOcc[owner] ??= {})[k] = v; }
      });
    };
    detachedEdges.forEach(([m, b]) => { collectOcc(m, b); collectOcc(b, m); });

    const applyFn = () => {
      batchUpdatePartStates(finalUpdates);
      if (detachedEdges.length === 0) return;
      set(s => {
        const nc = { ...s.connections };
        detachedEdges.forEach(([m, b]) => {
          if (nc[m]) { const ms = new Set(nc[m]); ms.delete(b); if (ms.size === 0) delete nc[m]; else nc[m] = ms; }
          if (nc[b]) { const bs = new Set(nc[b]); bs.delete(m); if (bs.size === 0) delete nc[b]; else nc[b] = bs; }
        });
        const ro: OccupiedPortMap = { ...s.occupiedPorts };
        Object.entries(removedOcc).forEach(([pid, kvs]) => {
          if (!ro[pid]) return;
          const cleaned = { ...ro[pid] };
          Object.keys(kvs).forEach(k => delete cleaned[k]);
          if (Object.keys(cleaned).length === 0) delete ro[pid]; else ro[pid] = cleaned;
        });
        return { connections: nc, occupiedPorts: ro };
      });
    };

    const revertFn = () => {
      batchUpdatePartStates(prevUpdates);
      if (detachedEdges.length === 0) return;
      set(s => {
        const nc = { ...s.connections };
        detachedEdges.forEach(([m, b]) => {
          nc[m] = nc[m] ? new Set(nc[m]) : new Set();
          nc[b] = nc[b] ? new Set(nc[b]) : new Set();
          nc[m].add(b); nc[b].add(m);
        });
        const ro: OccupiedPortMap = { ...s.occupiedPorts };
        Object.entries(removedOcc).forEach(([pid, kvs]) => {
          ro[pid] = { ...(ro[pid] || {}), ...kvs };
        });
        return { connections: nc, occupiedPorts: ro };
      });
    };

    const emptySnap: TopologySnapshot = {
      addedParts: {}, removedParts: {}, addedConnections: [], removedConnections: [],
    };
    const cmd = createTopologyCommand('TRANSFORM', emptySnap, applyFn, revertFn);

    applyFn();
    _history.push(cmd);
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });

    const moveMm = Math.hypot(t[0], t[1], t[2]) * 1000;
    const withN = moving.length > 1 ? `（含子装配 ${moving.length} 件）` : '';
    const movePart = (opts.autoMove && moveMm > 0.05) ? `，自动微移 ${moveMm.toFixed(1)}mm 重连` : '';
    const detachPart = detachedEdges.length > 0
      ? `，脱开 ${detachedEdges.length} 个连接`
      : (keptCount > 0 ? `，保持 ${keptCount} 个连接` : '');
    get().addLog(`${opts.label}（选中件 ${primaryId}${withN}）${movePart}${detachPart}`, 'ACTION');
  },

  rotateSelectedSingle: (angleRads: number) => {
    get()._transformSelectedSubassembly(
      (oldPose, pivot) => rotatePartAboutPivot(oldPose, pivot, [0, 1, 0], angleRads),
      { autoMove: true, label: `绕 Y 轴旋转 ${(angleRads * 180 / Math.PI).toFixed(0)}°` },
    );
  },

  flipSelected: () => {
    get()._transformSelectedSubassembly(
      (oldPose, pivot) => rotatePartAboutPivot(oldPose, pivot, [1, 0, 0], Math.PI),
      // 翻面时连接件（销/轴）留在原位充当连接，不随板翻到顶上（用户反馈）。
      { autoMove: true, label: `翻面 180°`, keepConnectorsFixed: true },
    );
  },

  translateSelectedGroup: (delta: Vec3) => {
    // 「连着的整体一起动」（用户确认的总规则）：平移移动**整个连通装配**——取所有选中件的
    // 连通分量并集（含传递相连的销/板/件），整体刚体平移、**保留所有连接**（不脱开）。
    // 这样移动板→板上的销一起动、点销连右板→左边整个装配跟过去；要把件从装配里分出来
    // 用工具栏「脱开」。
    const { selection, parts, connections, batchUpdatePartStates } = get();
    const ids = selection.allConnectedIds;
    if (ids.length === 0) return;

    const moveSet = new Set<string>();
    ids.forEach(id => { getConnectedGroup(connections, id, "").forEach(p => moveSet.add(p)); });

    const prevUpdates: Record<string, Partial<PartState>> = {};
    const nextUpdates: Record<string, Partial<PartState>> = {};
    moveSet.forEach(id => {
      const p = parts[id];
      if (!p) return;
      prevUpdates[id] = { position: [...p.position] as Vec3 };
      nextUpdates[id] = { position: [p.position[0] + delta[0], p.position[1] + delta[1], p.position[2] + delta[2]] as Vec3 };
    });
    if (Object.keys(nextUpdates).length === 0) return;

    const applyFn = () => get().batchUpdatePartStates(nextUpdates);
    const revertFn = () => get().batchUpdatePartStates(prevUpdates);
    const emptySnap: TopologySnapshot = {
      addedParts: {}, removedParts: {}, addedConnections: [], removedConnections: [],
    };
    const cmd = createTopologyCommand('TRANSFORM', emptySnap, applyFn, revertFn);

    batchUpdatePartStates(nextUpdates);
    _history.push(cmd);
    set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
    const mm = delta.map(d => (d * 1000).toFixed(1)).join(', ');
    get().addLog(`平移 [${mm}] mm（连通装配 ${Object.keys(nextUpdates).length} 件）`, 'ACTION');
  },

  commitAxialSliding: () => {
    const { snapPreState, parts } = get();
    if (snapPreState) {
        const nextPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
        snapPreState.movedPartIds.forEach(pid => {
            const p = parts[pid];
            if (p) nextPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
        });

        // 修自 issue #73：capture addedPartIds 各自的完整 PartState（含 ldrawId/
        // colorCode/zone），让 redo 能重建被 undo 删除的新增零件。原 redo 仅用
        // nextPositions（只含 position+quaternion）+ `if (rp[id])` 守卫，对 undo
        // 删过的 part 永远不会重建 → connection / occupiedPorts 引用 dangling part。
        const addedPartStates: Record<string, PartState> = {};
        (snapPreState.addedPartIds || []).forEach(pid => {
            const p = parts[pid];
            if (p) addedPartStates[pid] = JSON.parse(JSON.stringify(p)) as PartState;
        });

        const cmd = createSnapCommand(
            snapPreState,
            () => { // redo
                set(prev => {
                    const rp = { ...prev.parts };
                    // 1) 先把被 undo 删除的 addedPartIds 用 capture 的完整 state 重建
                    Object.entries(addedPartStates).forEach(([id, state]) => {
                        if (!rp[id]) rp[id] = state;
                    });
                    // 2) 再 apply nextPositions（含 movedPartIds 的最终位姿；新建零件
                    //    的最终位姿在 nextPositions 里，会覆盖步骤 1 的 capture pose）
                    Object.entries(nextPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
                    const rc = { ...prev.connections };
                    snapPreState.addedConnections.forEach(({ from, to }) => {
                        if (!rc[from]) rc[from] = new Set();
                        if (!rc[to]) rc[to] = new Set();
                        rc[from].add(to);
                        rc[to].add(from);
                    });
                    const ro: OccupiedPortMap = { ...prev.occupiedPorts };
                    (snapPreState.addedPortKeys || []).forEach(({ partId, key, peerId }) => {
                        ro[partId] = { ...(ro[partId] || {}), [key]: peerId };
                    });
                    return { parts: rp, connections: rc, occupiedPorts: ro };
                });
            },
            (snap) => { // undo
                set(prev => {
                    const rp = { ...prev.parts };
                    if (snap.addedPartIds) {
                        snap.addedPartIds.forEach(id => delete rp[id]);
                    }
                    Object.entries(snap.prevPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
                    const rc = { ...prev.connections };
                    snap.addedConnections.forEach(({ from, to }) => {
                        if (rc[from]) {
                            const nextSet = new Set(rc[from]);
                            nextSet.delete(to);
                            if (nextSet.size === 0) delete rc[from]; else rc[from] = nextSet;
                        }
                        if (rc[to]) {
                            const nextSet = new Set(rc[to]);
                            nextSet.delete(from);
                            if (nextSet.size === 0) delete rc[to]; else rc[to] = nextSet;
                        }
                    });
                    const ro: OccupiedPortMap = { ...prev.occupiedPorts };
                    if (snap.addedPartIds) {
                        snap.addedPartIds.forEach(id => { delete ro[id]; });
                    }
                    (snap.addedPortKeys || []).forEach(({ partId, key }) => {
                        const cur = ro[partId];
                        if (!cur) return;
                        const cleaned = { ...cur };
                        delete cleaned[key];
                        if (Object.keys(cleaned).length === 0) delete ro[partId];
                        else ro[partId] = cleaned;
                    });
                    return { parts: rp, connections: rc, occupiedPorts: ro };
                });
            }
        );
        _history.push(cmd);
    }

    const cp = get().continuousPlacementSource;
    if (cp) {
      // 连续放置模式：生成新的 instanceId 保持对齐状态
      const newInstanceId = `${cp.ldrawId}_${window.crypto.randomUUID().substring(0,8)}`;
      const newSelectedPort = { ...cp, partId: newInstanceId };
      set({
        interactionPhase: InteractionPhase.SOURCE_LOCKED,
        selectedPort: newSelectedPort,
        hoveredPort: null,
        slidingTarget: null,
        slideOffset: 0,
        snapPreState: null,
        canUndo: _history.canUndo,
        canRedo: _history.canRedo
      });
      get().addLog("Axial Sliding committed. Ready for next continuous placement.", 'ACTION');
    } else {
      set({ 
        interactionPhase: InteractionPhase.IDLE, 
        selectedPort: null, 
        hoveredPort: null, 
        slidingTarget: null,
        slideOffset: 0,
        snapPreState: null,
        canUndo: _history.canUndo,
        canRedo: _history.canRedo 
      });
      get().addLog("Axial Sliding committed.", 'ACTION');
    }
  },
  setBlocked: (r) => set({ interferenceReport: r }),
  setPhase: (p) => set({ interactionPhase: p }),
  commitAction: () => set({ interactionPhase: InteractionPhase.IDLE }),
  previewPart: (id: string | null) => {
    if (id) {
        get().addLog(`[DEBUG] Previewing part ${id}, incrementing usage count.`, 'ACTION');
        set(state => ({
            partUsages: {
                ...state.partUsages,
                [id]: (state.partUsages[id] || 0) + 1
            }
        }));
    }
    set({ 
      previewPartId: id,
      interactionPhase: id ? InteractionPhase.PREVIEWING : InteractionPhase.IDLE,
      continuousPlacementSource: null // 清除连续放置状态
    });
  },
  stagePart: (id) => {
    const p = get().parts[id];
    if (p) {
        // 记录操作前的状态，以便撤销
        const prevPartState = JSON.parse(JSON.stringify(p)) as PartState;
        const prevConnections = get().connections[id] ? Array.from(get().connections[id]) : [];
        const removedConns: Array<{ from: string; to: string }> = [];
        prevConnections.forEach(target => {
            removedConns.push({ from: id, to: target });
        });

        // 暂存零件被移走时，相关端口占用条目（自身全部 + 对端指向它的反向条目）需一并撤销，
        // 以便对端的孔重新进入"可拾取"状态。
        const curOcc = get().occupiedPorts;
        const removedOcc: Record<string, Record<string, string>> = {};
        if (curOcc[id] && Object.keys(curOcc[id]).length > 0) {
            removedOcc[id] = { ...curOcc[id] };
        }
        Object.keys(curOcc).forEach(peerId => {
            if (peerId === id) return;
            const matched: Record<string, string> = {};
            Object.entries(curOcc[peerId]).forEach(([k, v]) => {
                if (v === id) matched[k] = v;
            });
            if (Object.keys(matched).length > 0) removedOcc[peerId] = matched;
        });

        const clearOccupied = () => set(state => {
            const ro: OccupiedPortMap = { ...state.occupiedPorts };
            Object.entries(removedOcc).forEach(([partId, kvs]) => {
                const cur = ro[partId];
                if (!cur) return;
                const cleaned = { ...cur };
                Object.keys(kvs).forEach(k => delete cleaned[k]);
                if (Object.keys(cleaned).length === 0) delete ro[partId];
                else ro[partId] = cleaned;
            });
            delete ro[id];
            return { occupiedPorts: ro };
        });

        const restoreOccupied = () => set(state => {
            const ro: OccupiedPortMap = { ...state.occupiedPorts };
            Object.entries(removedOcc).forEach(([partId, kvs]) => {
                ro[partId] = { ...(ro[partId] || {}), ...kvs };
            });
            return { occupiedPorts: ro };
        });

        get().addLog(`Staging part: ${id}`);
        const slot = get().stagingGrid.assign(id);
        if (!slot) {
            get().addLog(`Staging tray FULL. Cannot stage ${id}`, 'ERROR');
            return;
        }

        const newPos = slot.worldPosition;

        const executeStage = () => {
            const currentSlot = get().stagingGrid.assign(id);
            if (currentSlot) {
                get().updatePartState(id, {
                    zone: ZoneType.STAGED,
                    position: currentSlot.worldPosition as Vec3,
                    quaternion: [0, 0, 0, 1] as Quat
                });
            }
            set(state => {
                const newConns = { ...state.connections };
                delete newConns[id];
                Object.keys(newConns).forEach(targetId => {
                    if (newConns[targetId].has(id)) {
                        const nextSet = new Set(newConns[targetId]);
                        nextSet.delete(id);
                        newConns[targetId] = nextSet;
                    }
                });
                return { connections: newConns };
            });
            clearOccupied();
        };

        const undoStage = () => {
            get().stagingGrid.releaseSlot(id);
            get().updatePartState(id, prevPartState);
            set(state => {
                const newConns = { ...state.connections };
                removedConns.forEach(c => {
                    if (!newConns[c.from]) newConns[c.from] = new Set();
                    if (!newConns[c.to]) newConns[c.to] = new Set();
                    newConns[c.from].add(c.to);
                    newConns[c.to].add(c.from);
                });
                return { connections: newConns };
            });
            restoreOccupied();
        };

        // 立即执行并入栈
        get().updatePartState(id, {
            zone: ZoneType.STAGED,
            position: newPos as Vec3,
            quaternion: [0, 0, 0, 1] as Quat // 重置为水平
        });

        set(state => {
            const newConns = { ...state.connections };
            // 清除自己的
            delete newConns[id];
            // 从邻居中删除自己
            Object.keys(newConns).forEach(targetId => {
                if (newConns[targetId].has(id)) {
                    const nextSet = new Set(newConns[targetId]);
                    nextSet.delete(id);
                    newConns[targetId] = nextSet;
                }
            });
            return { connections: newConns };
        });
        clearOccupied();

        const snap: TopologySnapshot = {
            addedParts: {},
            removedParts: {},
            addedConnections: [],
            removedConnections: removedConns,
            removedOccupiedPorts: removedOcc,
        };
        const cmd = createTopologyCommand('STAGE', snap, executeStage, undoStage);
        _history.push(cmd);
        set({ canUndo: _history.canUndo, canRedo: _history.canRedo });
    }
  }
}), {
  name: 'lego-cad-assembly-storage',
  partialize: (state) => persistShape(state),
  // Rehydrate 时需要把 connections 里的 Array 转回 Set
  merge: (persistedState: unknown, currentState: StoreState) => {
    const pState = persistedState as Partial<StoreState> & { connections?: Record<string, string[]>, hiddenParts?: string[] };
    const mergedConnections: ConnectionGraph = {};
    if (pState.connections) {
      Object.entries(pState.connections).forEach(([k, arr]) => {
        mergedConnections[k] = new Set(arr as string[]);
      });
    }
    return {
      ...currentState,
      ...pState,
      connections: mergedConnections,
      occupiedPorts: pState.occupiedPorts ?? {},
      hiddenParts: pState.hiddenParts ? new Set(pState.hiddenParts) : new Set(),
    };
  },
  onRehydrateStorage: () => (state) => {
    if (state) {
      state.stagingGrid.clearAll();
      Object.entries(state.parts).forEach(([id, p]) => {
        if (p.zone === ZoneType.STAGED) {
          state.stagingGrid.assign(id);
        }
      });
      state.addLog('State rehydrated from local storage.');
    }
  }
}));

// 为 E2E 测试环境暴露入口
if (typeof window !== 'undefined') {
  // @ts-ignore
  window.__STORE__ = useStore;
}

// ---------------------------------------------------------------------------
// 派生状态 Selectors (SRP 抽象)
// ---------------------------------------------------------------------------
export const useIsTargetSeekingPhase = () => useStore(s => s.interactionPhase === InteractionPhase.SOURCE_LOCKED);

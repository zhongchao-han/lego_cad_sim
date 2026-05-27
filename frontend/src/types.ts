/**
 * types.ts
 * Interaction v1.2 统一类型定义
 */

// --- 基础数学类型 ---
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Mat3 = number[][] | number[];

// --- 交互阶段 (FSM) ---
export enum InteractionPhase {
  IDLE = 'IDLE',                       // 空闲
  PREVIEWING = 'PREVIEWING',           // 预览（从库中拿起）
  SOURCE_LOCKED = 'SOURCE_LOCKED',     // 已锁定源端口
  AXIAL_SLIDING = 'AXIAL_SLIDING',     // 沿轴滑动调节深度
  ANIMATING_SNAP = 'ANIMATING_SNAP',   // 正在播放对齐动画
  FREE_PLACING = 'FREE_PLACING',       // 悬浮放置（跟随鼠标）
}

// --- 选择深度 (Drill-down) ---
export enum SelectionLevel {
  GROUP = 'GROUP',           // 选中物理连通组
  INDIVIDUAL = 'INDIVIDUAL', // 选中单个零件
  /** 走法 A 期 B.1：plug-level 视觉/选择层（user 视角的"整片接口"，
   *  比如 2x4 plate 顶面 = 1 plug、2780 销头/销尾 = 各 1 plug）。
   *  B.1 仅 hover 联动 — port hover 时同 plug 兄弟 port 全亮发现性反馈；
   *  click / commit 仍走 port-level，留 B.2/B.3。 */
  PLUG = 'PLUG',
}

/** 选中锚点详情 */
export interface SelectionAnchor {
  primaryId: string | null;
  level: SelectionLevel;
  allConnectedIds: string[];
  excludedIds: string[];
}

// --- 区域定义 ---
export enum ZoneType {
  ACTIVE_ARENA = 'ACTIVE_ARENA',
  PREVIEW      = 'PREVIEW',
}

// 自由放置阶段的射线投射策略
export enum FreePlacingProjectionMode {
  SCENE_RAYCAST = 'SCENE_RAYCAST', // 命中场景物体（粘贴等通用路径）
  GROUND_PLANE  = 'GROUND_PLANE',  // 仅与 y=0 平面求交（Drop to Ground）
}

// --- 零件实体与状态 ---
export interface PartState {
  ldrawId: string;
  position: Vec3;
  quaternion: Quat;
  colorCode: number;
  zone: ZoneType;
  isGrounded?: boolean; // 是否锚定到坐标系
}

/**
 * L44 / L50：从后端 /api/get_verified_parts 拿到的零件目录条目。
 * 同 ldrawId 多个 PartState 实例共用一份 catalog 元数据；store 里维护
 * partCatalog: Record<ldrawId, PartCatalogEntry>，由 PartLibraryPanel 拉取后填入。
 */
/**
 * L51b PR-B：反力求解结果。
 * 后端 /api/compute_reactions 返：{ edge_key: ReactionData }。
 * edge_key 形如 "parent::child::uuidkey"；前端只用作字典键。
 */
export interface ReactionData {
  parentId: string;
  childId: string;
  /** 世界坐标系下 wrench 作用点（来自 port_parent 局部位置 → 世界）。 */
  anchorWorld: Vec3;
  force:  Vec3;
  torque: Vec3;
  magnitudeForce:  number; // N
  magnitudeTorque: number; // N·m
  /** L51b PR-C：圆截面 von Mises 应力近似；非 CYLINDER edge 为 null。 */
  stress: EdgeStress | null;
}

export interface EdgeStress {
  axialForceN:    number;   // 轴向力（拉 > 0 / 压 < 0）
  shearForceN:    number;   // 横向剪力 magnitude
  normalStressPa: number;   // σ = |F_axial| / A
  shearStressPa:  number;   // τ = F_lateral / A
  vonMisesPa:     number;   // √(σ² + 3·τ²)
  safetyRatio:    number;   // σ_vm / ABS_yield (40 MPa)；< 1 安全，>= 1 屈服
  yields:         boolean;
}

export interface PartCatalogEntry {
  partId:    string;       // .dat 文件名，例如 "3001.dat"
  name:      string;       // LDraw 首行注释解析出的可读名
  category:  string;       // L50 分级目录桶
  toothCount: number | null; // L44 齿数（非齿轮 / 异形齿轮 = null）
  /** L51 单零件估算质量（kg）。GLB 没烘 / 估算失败 = null，store 走默认 0.001 kg。 */
  massKg: number | null;
  /** L51 part 局部坐标系下的质心（米）。L51b PR-A 起 staticsMath 真使用。 */
  comLocal: Vec3 | null;
  /** L51b PR-A：part 局部坐标系下的 axis-aligned bbox 尺寸（米）。null 时
   *  staticsMath footprint 退化到 part.position 单点（v1 行为）。 */
  bboxSize: Vec3 | null;
  /** L51b PR-A：bbox 中心相对 part origin 的偏移（米，part-local 坐标系）。 */
  bboxCenter: Vec3 | null;
  portCount?: number;
  /** 走法 A 期 A2 — 1b：plug 总数。baked 自 ldraw_port_configs.json
   *  plug_version=v1；老数据缺字段时 = 0 / undefined。 */
  plugCount?: number;
  meshUrl?:   string;
}

// --- 端口与场站 (Site/Port v1.2) ---
export interface Port {
  id: string;
  parentSiteId: string;
  direction: Vec3; // Z轴法向
  gender: 'MALE' | 'FEMALE';
  profile: 'CYLINDER' | 'CROSS' | 'STUD';
}

export interface Site {
  id: string;
  position: Vec3;
  type: string;
  ports: Record<string, Port>;
  occupiedBy: string | null; // 占用的零件 ID
}

// --- 物理反馈报告 ---
export interface InterferenceReport {
  isBlocked: boolean;
  blockingPartId: string | null;
  contactPoints: Vec3[];
  reason: 'MESH_COLLISION' | 'STOP_FEATURE' | 'OVER_CONSTRAINED' | null;
}

// --- 原始选中端口信息 (用于向下兼容旧逻辑，逐步淘汰) ---
export interface SelectedPortInfo {
  partId: string;
  ldrawId: string;
  portType: string;
  position: Vec3;
  rotation: Mat3;
  globalPos: Vec3;
  globalQuat: Quat;
  isFromPreview?: boolean; // 用于标记此端口是否刚从零件库选出，以开启连续拼接(Stamp)模式
  /** 走法 A 期 B.1：plug-level 联动需要 — 同 plug 兄弟 port hover 时
   *  通过比较此字段联动高亮。baked 自 ldraw_port_configs.json；老
   *  数据或装饰零件可能缺。 */
  plug_id?: string;
  /** 走法 A 期 B.3-extension：selected source port 所属 plug 的 member
   *  总数。让 pre-commit 预览能算 min(source_count, target_count) 上界，
   *  不需要从 plugs 数组反查。仅在 B.2 anchor pick 路径填入；普通 port
   *  click 不设。 */
  plug_port_count?: number;
}

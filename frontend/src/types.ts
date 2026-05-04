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
  STAGED       = 'STAGED',
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
export interface PartCatalogEntry {
  partId:    string;       // .dat 文件名，例如 "3001.dat"
  name:      string;       // LDraw 首行注释解析出的可读名
  category:  string;       // L50 分级目录桶
  toothCount: number | null; // L44 齿数（非齿轮 / 异形齿轮 = null）
  portCount?: number;
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
}

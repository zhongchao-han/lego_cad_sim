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

// --- 零件实体与状态 ---
export interface PartState {
  ldrawId: string;
  position: Vec3;
  quaternion: Quat;
  colorCode: number;
  zone: ZoneType;
  isGrounded?: boolean; // 是否锚定到坐标系
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
}

/**
 * historyStack.ts
 * ================
 * 命令模式 Undo/Redo 栈 — 纯逻辑模块，不依赖 Zustand 或 React。
 *
 * 设计原则：
 *   - 采用 Diff Snapshot（局部差异快照），禁止深拷贝整个场景图
 *   - ActionCommand 持有 execute/undo，加上发生前的最小快照
 *   - HistoryStack 管理 past/future 两个队列，上限 maxSize 防止内存泄漏
 *
 * 用法：
 *   const history = new HistoryStack(50);
 *   history.push(snapCommand);
 *   history.undo();
 *   history.redo();
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 可撤销动作的通用接口。S = 快照类型。*/
export interface ActionCommand<S = unknown> {
  readonly type: string;
  readonly snapshot: S;   // 执行前的局部差异快照（仅保存受影响的字段）
  execute(): void;
  undo(): void;
}

/** SnapCommand 快照：仅保存被移动的零件在 Snap 前的位置/姿态 */
export interface SnapSnapshot {
  movedPartIds: string[];
  /** 被移动零件 Snap 之前的 position + quaternion */
  prevPositions: Record<string, { position: [number, number, number]; quaternion: [number, number, number, number] }>;
  /** Snap 之前不存在的连接 — 撤销时删除 */
  addedConnections: Array<{ from: string; to: string }>;
  /** Snap 引入的端口占用条目（双向各一）— 撤销时按此清单回滚。peerId 仅用于 redo 重写。 */
  addedPortKeys?: Array<{ partId: string; key: string; peerId: string }>;
  /** Snap 引入的零件实例 — 撤销时整个移除（含其端口占用条目）。 */
  addedPartIds?: string[];
}

// ---------------------------------------------------------------------------
// HistoryStack
// ---------------------------------------------------------------------------

export class HistoryStack {
  private past: ActionCommand[] = [];
  private future: ActionCommand[] = [];

  constructor(private readonly maxSize: number = 50) {}

  /** 推入新命令（清空 future 栈）。*/
  push(cmd: ActionCommand): void {
    this.past.push(cmd);
    if (this.past.length > this.maxSize) {
      this.past.shift();   // 超限丢弃最旧记录
    }
    this.future = [];      // 有新操作时清空 redo 栈
  }

  undo(): boolean {
    const cmd = this.past.pop();
    if (!cmd) return false;
    cmd.undo();
    this.future.push(cmd);
    return true;
  }

  redo(): boolean {
    const cmd = this.future.pop();
    if (!cmd) return false;
    cmd.execute();
    this.past.push(cmd);
    return true;
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /** 清空整个历史（用于 Reset 场景）。*/
  clear(): void {
    this.past = [];
    this.future = [];
  }

  get pastCount(): number  { return this.past.length; }
  get futureCount(): number { return this.future.length; }
}

// ---------------------------------------------------------------------------
// SnapCommand 工厂
// ---------------------------------------------------------------------------

/**
 * 构建一个可撤销的 Snap 命令。
 *
 * @param snapshot - Snap 前保存的局部差异快照
 * @param applyFn  - 执行/重做：将 snapshot 的零件移动到目标位置
 * @param revertFn - 撤销：将零件恢复到 snapshot.prevPositions
 */
export function createSnapCommand(
  snapshot: SnapSnapshot,
  applyFn:  () => void,
  revertFn: (snap: SnapSnapshot) => void,
): ActionCommand<SnapSnapshot> {
  return {
    type: 'SNAP',
    snapshot,
    execute: applyFn,
    undo: () => revertFn(snapshot),
  };
}

// ---------------------------------------------------------------------------
// TopologyCommand (增删零件/连接)
// ---------------------------------------------------------------------------

import type { PartState } from './types';

export interface TopologySnapshot {
  addedParts: Record<string, PartState>;     // 新增的零件字典
  removedParts: Record<string, PartState>;   // 被移除的零件字典
  addedConnections: Array<{ from: string; to: string }>;
  removedConnections: Array<{ from: string; to: string }>;
  /**
   * 被移除的端口占用条目（双向）。删除零件时由 store 计算并写入；
   * 撤销时整体写回 occupiedPorts。键 = partId，值 = { portKey: peerId }。
   */
  removedOccupiedPorts?: Record<string, Record<string, string>>;
}

/**
 * 构建一个可撤销的 Topology 命令 (用于 Add, Delete, Clone, Paste)
 *
 * @param type     - 命令分类 (如 'ADD', 'DELETE', 'PASTE')
 * @param snapshot - 包含了新增/删除实体结构的差异
 * @param applyFn  - 执行/重做: 将对应的零件加入/移除
 * @param revertFn - 撤销: 逆转 applyFn 的操作
 */
export function createTopologyCommand(
  type: string,
  snapshot: TopologySnapshot,
  applyFn: () => void,
  revertFn: (snap: TopologySnapshot) => void,
): ActionCommand<TopologySnapshot> {
  return {
    type,
    snapshot,
    execute: applyFn,
    undo: () => revertFn(snapshot),
  };
}

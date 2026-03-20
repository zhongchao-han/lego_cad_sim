/**
 * interactionFSM.ts
 * ==================
 * 用户交互状态机 — 纯逻辑模块，无任何框架依赖。
 *
 * 阶段定义：
 *   IDLE            — 空闲，用户可自由旋转场景
 *   SOURCE_LOCKED   — 已锁定第一个端口（Source），等待用户点击 Target
 *   ANIMATING_SNAP  — 正在播放落位动画（锁定用户输入）
 *
 * 合法跳转（单向）：
 *   IDLE            → SOURCE_LOCKED   (点击第一个端口)
 *   SOURCE_LOCKED   → IDLE            (取消选择 / ESC)
 *   SOURCE_LOCKED   → ANIMATING_SNAP  (点击第二个端口，触发 Snap)
 *   ANIMATING_SNAP  → IDLE            (动画播放完毕 / onComplete 回调)
 */

export enum InteractionPhase {
  IDLE                 = 'IDLE',
  PICKING_FROM_LIBRARY = 'PICKING_FROM_LIBRARY', // 正在物料库或工作台中“预览”零件，尚未选点
  SOURCE_LOCKED        = 'SOURCE_LOCKED',
  ANIMATING_SNAP       = 'ANIMATING_SNAP',
}

// 合法跳转表
const VALID_TRANSITIONS: Record<InteractionPhase, readonly InteractionPhase[]> = {
  [InteractionPhase.IDLE]:           [InteractionPhase.SOURCE_LOCKED, InteractionPhase.PICKING_FROM_LIBRARY],
  [InteractionPhase.PICKING_FROM_LIBRARY]: [InteractionPhase.IDLE, InteractionPhase.SOURCE_LOCKED],
  [InteractionPhase.SOURCE_LOCKED]:  [InteractionPhase.IDLE, InteractionPhase.ANIMATING_SNAP],
  [InteractionPhase.ANIMATING_SNAP]: [InteractionPhase.IDLE],
};

/**
 * 检查从 `from` 跳转到 `to` 是否合法。
 */
export function isValidTransition(from: InteractionPhase, to: InteractionPhase): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * 执行跳转并返回新阶段。
 * 非法跳转会抛出 Error（编程错误，不应被静默忽略）。
 */
export function transition(from: InteractionPhase, to: InteractionPhase): InteractionPhase {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `[InteractionFSM] 非法跳转: ${from} → ${to}. ` +
      `合法目标: [${VALID_TRANSITIONS[from].join(', ')}]`
    );
  }
  return to;
}

/**
 * 根据用户动作推断目标阶段（封装常见跳转语义）。
 */
export const InteractionEvents = {
  /** 用户点击侧边栏零件，开启预览 */
  pickFromLibrary: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.PICKING_FROM_LIBRARY),

  /** 预览中旋转零件，然后选中了一个特定源端口 */
  pickSourcePort: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.SOURCE_LOCKED),

  /** 用户在场内点击了一个已落位零件的端口（传统 Snap） */
  lockSource: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.SOURCE_LOCKED),

  /** 用户取消（预览取消或选点后取消） */
  cancel: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.IDLE),

  /** 开始 Snap 动画 */
  beginSnap: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.ANIMATING_SNAP),

  /** 动画完毕 */
  completeSnap: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.IDLE),
} as const;

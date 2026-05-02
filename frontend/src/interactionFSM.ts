/**
 * interactionFSM.ts
 * ==================
 * 用户交互状态机 — Interaction v1.2 增强版。
 */

import { InteractionPhase } from './types';

// 合法跳转表
const VALID_TRANSITIONS: Record<InteractionPhase, readonly InteractionPhase[]> = {
  [InteractionPhase.IDLE]:           [InteractionPhase.IDLE, InteractionPhase.SOURCE_LOCKED, InteractionPhase.PREVIEWING],
  [InteractionPhase.PREVIEWING]:     [InteractionPhase.IDLE, InteractionPhase.SOURCE_LOCKED, InteractionPhase.PREVIEWING],
  [InteractionPhase.SOURCE_LOCKED]:  [InteractionPhase.IDLE, InteractionPhase.ANIMATING_SNAP, InteractionPhase.PREVIEWING, InteractionPhase.AXIAL_SLIDING],
  [InteractionPhase.AXIAL_SLIDING]:   [InteractionPhase.IDLE, InteractionPhase.SOURCE_LOCKED],
  [InteractionPhase.ANIMATING_SNAP]: [InteractionPhase.IDLE],
  [InteractionPhase.FREE_PLACING]:   [InteractionPhase.IDLE],
};

/**
 * 检查从 `from` 跳转到 `to` 是否合法。
 */
export function isValidTransition(from: InteractionPhase, to: InteractionPhase): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * 执行跳转并返回新阶段。
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
 * 根据用户动作推断目标阶段。
 */
export const InteractionEvents = {
  /** 用户点击侧边栏或暂存区零件，开启预览 */
  previewPart: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.PREVIEWING),

  /** 预览中选中了一个特定源端口 */
  pickSourcePort: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.SOURCE_LOCKED),

  /** 吸附成功，进入深度调节模式 */
  beginSliding: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.AXIAL_SLIDING),

  /** 用户取消或操作完成 */
  abort: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.IDLE),

  /** 开始 Snap 动画 */
  beginSnap: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.ANIMATING_SNAP),

  /** 动画完毕 */
  completeSnap: (current: InteractionPhase): InteractionPhase =>
    transition(current, InteractionPhase.IDLE),
} as const;

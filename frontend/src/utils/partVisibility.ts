/**
 * partVisibility.ts
 * =================
 * 零件「是否对用户陈列」的过滤判据。
 *
 * 已弃用（Obsolete）零件：LDraw 描述名里带 "Obsolete"（中文库对应「已弃用」）。
 * 全库约 72 个，多为被新版替代的旧件，不应出现在库/搜索里干扰用户。
 * 注意：LDraw 的 "~" 前缀表示「子件/别名/非独立件」（全库 500+，含正经组件如
 * 电机外壳），**不是**弃用标记，故不据此过滤。
 */

export function isDeprecatedPart(name?: string | null): boolean {
  return /obsolete/i.test(name || '');
}

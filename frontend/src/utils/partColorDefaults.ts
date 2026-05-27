/**
 * partColorDefaults.ts
 * ====================
 * 零件「固定惯例色」查询。
 *
 * 设计原则（Why）：
 *   LDraw 零件图纸（.dat）中颜色默认为 16 号「Main Color 占位符」，
 *   图纸只给几何，不带现实颜色。为让零件库全集都有可预期的固定色，
 *   我们据零件 category（backend/category.py 注入）按惯例为「每个零件」
 *   定死一个颜色——销=蓝、轴=深灰、电机=深蓝灰、轮胎=黑、结构件=浅蓝灰，
 *   个别高频件另有现实惯例色（无阻力销=灰、2L 缺口轴=红、连杆=红/绿…）。
 *
 *   全表由 scripts/gen_part_colors.py 据「类别惯例 + 高频件特例」生成，
 *   见 partColors.generated.ts（source of truth 在脚本里，勿手改生成文件）。
 *
 * 全锁语义：
 *   库内零件一律有固定色（hasPresetColor 恒 true），改色对其不可用——
 *   见 store.recolorSelected。库外 / 未知零件（不在生成表内）回退到
 *   activeColorCode 且允许改色。
 */

import { PART_COLORS } from './partColors.generated';

/** 归一化零件号：去 .dat 后缀、转小写。实例 ID（含 "_xxxx" 后缀）不剥，
 *  故 "6558_abc" 不会误命中 "6558"——与 clearPartCache 命名规约同源。 */
function normalize(partId: string): string {
  return partId.toLowerCase().replace(/\.dat$/, '');
}

/**
 * 获取零件的固定默认色码。
 *
 * @param partId - 零件文件名（支持带或不带 .dat 后缀，大小写不敏感）
 * @param fallbackColorCode - 生成表无命中时使用的颜色（库外件 / 用户全局选色）
 * @returns LDraw 颜色码
 */
export function getDefaultColorCode(partId: string, fallbackColorCode: number): number {
  const found = PART_COLORS[normalize(partId)];
  return found !== undefined ? found : fallbackColorCode;
}

/**
 * 该零件是否有「固定惯例色」（颜色锁定，不允许用户改色）。
 * 库内件全部为 true（全锁）；库外 / 未知件为 false。见 recolorSelected。
 */
export function hasPresetColor(partId: string): boolean {
  return PART_COLORS[normalize(partId)] !== undefined;
}

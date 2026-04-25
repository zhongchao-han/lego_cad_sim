/**
 * partColorDefaults.ts
 * ====================
 * 乐高科技件「经典颜色」默认字典。
 *
 * 设计原则（Why）：
 *   LDraw 零件图纸（.dat）中颜色默认为 16 号"Main Color 占位符"，
 *   从这些图纸中只能得到几何信息，而无法得知该零件在现实中常见的颜色。
 *   本字典弥补这一缺失，为高频科技件提供直觉上正确的默认色，
 *   避免所有零件都显示为相同的灰色，造成学习门槛和视觉混乱。
 *
 * 使用规则：
 *   - Key: 零件文件名（不含路径，不含 .dat 后缀，小写）
 *   - Value: LDraw 颜色代码（整数）
 *   - 未在字典中的零件，回退至 Store 中的 activeColorCode（用户选择值）
 *
 * 维护指南：
 *   添加新条目时，请参照 https://www.ldraw.org/library/official/ 中的
 *   LDConfig.ldr 颜色标准表，确保颜色码的准确性。
 */

const DEFAULT_PART_COLORS: Readonly<Record<string, number>> = {
  // ─── 销 (Pins) ───────────────────────────────────────────────────────────────
  // 摩擦销（3M，蓝色）
  '6558':   1,    // Technic Pin Long with Friction (Blue)
  '32054':  1,    // Technic Pin with Friction (Blue)
  // 普通销（无阻力，浅灰色或特定颜色）
  '3673':   71,   // Technic Pin (Light Bluish Gray)
  '3749':   71,   // Technic Axle Pin without Friction (Light Bluish Gray)
  '4186017': 19,  // Technic Axle Pin without Friction (Tan - Physical Colour Shortcut)
  // 短摩擦销
  '4274':   71,   // Technic Pin 1/2 (Light Bluish Gray)
  // 带十字销
  '32556':  1,    // Technic Pin 3L with Friction (Blue)
  // ─── 十字轴 (Axles) ─────────────────────────────────────────────────────────
  '3705':   8,    // Technic Axle 4 (Dark Gray - older color convention)
  '32062':  4,    // Technic Axle 2 Notched (Red)
  '4519':   8,    // Technic Axle 3 (Dark Gray)
  '3706':   8,    // Technic Axle 6 (Dark Gray)
  '44294':  8,    // Technic Axle 7 (Dark Gray)
  '3707':   8,    // Technic Axle 8 (Dark Gray)
  '55013':  8,    // Technic Axle 11 (Dark Gray)
  '3737':   8,    // Technic Axle 10 (Dark Gray)
  // ─── 连接块 / 十字+孔梁 (Beams & Liftarms) ───────────────────────────────────
  '32523':  4,    // Technic Liftarm 3M (Red/commonly seen in yellow or black)
  '32528':  2,    // Technic Liftarm 1x2 (Green)
  '41677':  7,    // Technic Liftarm 1x2 Thin with Pin Hole (Light Gray)
  // ─── 连接器 (Connectors) ─────────────────────────────────────────────────────
  '32039':  71,   // Technic Pin with Axle Hole (Light Bluish Gray)
} as const;

/**
 * 获取零件的默认颜色码。
 *
 * @param partId - 零件文件名（支持带或不带 .dat 后缀，大小写不敏感）
 * @param fallbackColorCode - 字典无命中时使用的颜色（用户全局选色，来自 Store）
 * @returns LDraw 颜色码
 */
export function getDefaultColorCode(partId: string, fallbackColorCode: number): number {
  const normalized = partId.toLowerCase().replace(/\.dat$/, '');
  const found = DEFAULT_PART_COLORS[normalized];
  if (found !== undefined) {
    return found;
  }
  return fallbackColorCode;
}

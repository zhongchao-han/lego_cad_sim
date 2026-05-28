/**
 * partColorDefaults.test.ts
 * =========================
 * getDefaultColorCode / hasPresetColor —— 据生成表 partColors.generated.ts
 * 的固定惯例色查询 + .dat 后缀 + 大小写归一化。
 *
 * 全锁语义：库内零件一律有固定色（hasPresetColor 恒 true），库外件回退。
 * 生成表 source of truth = scripts/gen_part_colors.py（类别惯例 + 高频件特例）。
 */

import { describe, it, expect } from 'vitest';
import { getDefaultColorCode, hasPresetColor } from '../utils/partColorDefaults';

describe('getDefaultColorCode', () => {
  it('case 1: 高频件特例命中 — 6558 (蓝销) → 1', () => {
    expect(getDefaultColorCode('6558', 7)).toBe(1);
  });

  it('case 2: 带 .dat 后缀 → 仍命中', () => {
    expect(getDefaultColorCode('6558.dat', 7)).toBe(1);
  });

  it('case 3: 大小写不敏感 — partId 大写仍命中', () => {
    expect(getDefaultColorCode('6558.DAT', 7)).toBe(1);
    expect(getDefaultColorCode('6558.Dat', 7)).toBe(1);
  });

  it('case 4: 库外件（不在生成表）→ fallback 到 activeColorCode', () => {
    expect(getDefaultColorCode('999999', 14)).toBe(14);
    expect(getDefaultColorCode('999999.dat', 7)).toBe(7);
  });

  it('case 5: 含 instance suffix 的 partId (e.g. "6558_xxxxxxxx") → 不命中表 (因为 .dat 后缀正则不剥 instance)，走 fallback', () => {
    // instance partId 不应该误命中表中的 "6558" — 这跟 issue #75 (clearPartCache)
    // 同源的命名规约。这里 lock 当前行为：实例 ID 走 fallback 是正确语义。
    expect(getDefaultColorCode('6558_abc12345', 99)).toBe(99);
  });

  // 以下色值来自生成表（Rebrickable 各件最常见真实色 + 规则兜底），
  // 作回归快照锁定；刷新真实色数据后随之更新。
  it('case 6: 功能件真实色 — 长摩擦销蓝 / 摩擦销黑 / 轴4黑 / 轴5浅灰 / 轴2缺口红', () => {
    expect(getDefaultColorCode('6558', 0)).toBe(1);  // 长摩擦销 → 蓝
    expect(getDefaultColorCode('2780', 0)).toBe(0);  // 摩擦销 → 黑
    expect(getDefaultColorCode('3705', 0)).toBe(0);  // Axle 4 → 黑
    expect(getDefaultColorCode('32073', 0)).toBe(71); // Axle 5 → 浅蓝灰
    expect(getDefaultColorCode('32062', 0)).toBe(4);  // Axle 2 Notched → 红
  });

  it('case 7: 结构件真实色以黑/灰为主（不再硬上鲜艳色）', () => {
    expect(getDefaultColorCode('71709', 4)).toBe(0);  // Panel 3x7 → 黑
    expect(getDefaultColorCode('32316', 4)).toBe(0);  // Beam 5 → 黑
    expect(getDefaultColorCode('39369', 4)).toBe(14); // Beam 基板 → 黄（该件现实多为黄）
  });

  it('case 8: fallback=0 时库外件仍返回 0（不强制非零）', () => {
    expect(getDefaultColorCode('does_not_exist', 0)).toBe(0);
  });
});

describe('hasPresetColor — 固定惯例色件（改色锁定）判定', () => {
  it('库内件 → true（销/轴/结构件全锁；含 .dat / 大小写）', () => {
    expect(hasPresetColor('3673')).toBe(true);
    expect(hasPresetColor('3673.dat')).toBe(true);
    expect(hasPresetColor('4519.DAT')).toBe(true);
    expect(hasPresetColor('6558')).toBe(true);
    expect(hasPresetColor('71709')).toBe(true);     // Panel：全锁后也锁
    expect(hasPresetColor('39369.dat')).toBe(true); // Beam：全锁后也锁
  });
  it('库外 / 未知件 → false', () => {
    expect(hasPresetColor('999999')).toBe(false);
    expect(hasPresetColor('does_not_exist')).toBe(false);
  });
  it('实例 ID（带 suffix）→ false（不误命中）', () => {
    expect(hasPresetColor('3673_abc12345')).toBe(false);
  });
});

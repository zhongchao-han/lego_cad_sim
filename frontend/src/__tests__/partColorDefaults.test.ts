/**
 * partColorDefaults.test.ts
 * =========================
 * 审计 Round 3-D — getDefaultColorCode 字典查询 + .dat 后缀 + 大小写归一化
 *
 * 字典是 source of truth for "经典默认色"，新加 high priority part 时
 * 应该同步加到字典；本测保护已有条目不被误删 / 误改。
 */

import { describe, it, expect } from 'vitest';
import { getDefaultColorCode } from '../utils/partColorDefaults';

describe('getDefaultColorCode', () => {
  it('case 1: 字典命中 — 6558 (蓝销) → 1', () => {
    expect(getDefaultColorCode('6558', 7)).toBe(1);
  });

  it('case 2: 带 .dat 后缀 → 仍命中', () => {
    expect(getDefaultColorCode('6558.dat', 7)).toBe(1);
  });

  it('case 3: 大小写不敏感 — partId 大写仍命中', () => {
    expect(getDefaultColorCode('6558.DAT', 7)).toBe(1);
    expect(getDefaultColorCode('6558.Dat', 7)).toBe(1);
  });

  it('case 4: 未命中 → fallback 到 activeColorCode', () => {
    expect(getDefaultColorCode('999999', 14)).toBe(14);
    expect(getDefaultColorCode('999999.dat', 7)).toBe(7);
  });

  it('case 5: 含 instance suffix 的 partId (e.g. "6558_xxxxxxxx") → 不命中字典 (因为 .dat 后缀正则不剥 instance)，走 fallback', () => {
    // instance partId 不应该误命中字典中的"6558" — 这跟 issue #75 (clearPartCache)
    // 同源的命名规约。这里 lock 当前行为：实例 ID 走 fallback 是正确语义。
    expect(getDefaultColorCode('6558_abc12345', 99)).toBe(99);
  });

  it('case 6: 字典核心条目 lock — 销 (3673 浅灰) / 轴 (4519 深灰) / 红色销 (32062 红)', () => {
    expect(getDefaultColorCode('3673', 0)).toBe(71); // Light Bluish Gray
    expect(getDefaultColorCode('4519', 0)).toBe(8);  // Dark Gray
    expect(getDefaultColorCode('32062', 0)).toBe(4); // Red
  });

  it('case 7: fallback=0 时仍返回 0（不强制非零）', () => {
    expect(getDefaultColorCode('does_not_exist', 0)).toBe(0);
  });
});

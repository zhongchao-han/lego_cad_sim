/**
 * predictPlugSnapUpperBound.test.ts
 * ==================================
 * B.3-extension — pre-commit 预览上界 启发式纯函数单测。
 *
 * 覆盖：
 *   - 完整契约（缺任一字段 → null）
 *   - min(source, target) 正确返回
 *   - 兼容性筛（极性 + profile）
 *   - 顺序无关
 *   - 单 port plug 退化 = 1（callsite 自行决定 > 1 才显示）
 *   - 装饰类零件无 plug_id → 上层不会调（这里只测函数本身）
 */

import { describe, it, expect } from 'vitest';
import { predictPlugSnapUpperBound } from '../utils/pickPlugAnchor';

describe('predictPlugSnapUpperBound — B.3-extension pre-commit 预览', () => {
  it('case 1: 完整匹配 — 8 stud vs 8 tube → 8', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',
      sourcePlugPortCount: 8,
      targetPortType: 'tube',
      targetPlugPortCount: 8,
    })).toBe(8);
  });

  it('case 2: 不等数量 — min — 8 stud vs 4 tube → 4', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',
      sourcePlugPortCount: 8,
      targetPortType: 'tube',
      targetPlugPortCount: 4,
    })).toBe(4);
  });

  it('case 3: 反向 min — 2 stud vs 8 tube → 2', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',
      sourcePlugPortCount: 2,
      targetPortType: 'tube',
      targetPlugPortCount: 8,
    })).toBe(2);
  });

  it('case 4: 极性不兼容 — MALE↔MALE → null', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',  // MALE
      sourcePlugPortCount: 8,
      targetPortType: 'stud',  // MALE
      targetPlugPortCount: 8,
    })).toBeNull();
  });

  it('case 5: profile 不匹配 — STUD↔CYL → null', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',     // MALE STUD
      sourcePlugPortCount: 8,
      targetPortType: 'peghole',  // FEMALE CYL
      targetPlugPortCount: 4,
    })).toBeNull();
  });

  it('case 6: 顺序无关 — FEMALE↔MALE 反过来 → min', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'peghole',   // FEMALE
      sourcePlugPortCount: 4,
      targetPortType: 'peg',       // MALE
      targetPlugPortCount: 2,
    })).toBe(2);
  });

  it('case 7: 单 port plug — 1 stud vs 1 tube → 1（callsite 决定不显示）', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',
      sourcePlugPortCount: 1,
      targetPortType: 'tube',
      targetPlugPortCount: 1,
    })).toBe(1);
  });

  it('case 8: 缺源 plug_port_count → null', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',
      sourcePlugPortCount: undefined,
      targetPortType: 'tube',
      targetPlugPortCount: 8,
    })).toBeNull();
  });

  it('case 9: 缺目标 plug_port_count → null', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',
      sourcePlugPortCount: 8,
      targetPortType: 'tube',
      targetPlugPortCount: undefined,
    })).toBeNull();
  });

  it('case 10: 缺源 portType → null', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: undefined,
      sourcePlugPortCount: 8,
      targetPortType: 'tube',
      targetPlugPortCount: 8,
    })).toBeNull();
  });

  it('case 11: 0 count → null（防御性）', () => {
    expect(predictPlugSnapUpperBound({
      sourcePortType: 'stud',
      sourcePlugPortCount: 0,
      targetPortType: 'tube',
      targetPlugPortCount: 8,
    })).toBeNull();
  });
});

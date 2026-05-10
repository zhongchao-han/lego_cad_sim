/**
 * partLibraryBuckets.test.ts
 * ==========================
 * F4 — PartLibraryPanel 桶分类 + 渲染顺序契约单测
 *
 * 覆盖 utils/partLibraryBuckets.ts 抽出的纯函数：
 *   - computeBuckets：Frequent (usage / HIGH_PRIORITY) + category 分组 + 各桶排序
 *   - orderBucketNames：Frequent 优先 + CATEGORY_ORDER 顺序 + 未知 category 字母兜底
 *
 * 这两个函数是 backend/category.py 的前端镜像消费方。后端 CATEGORY_ORDER
 * 漂移 / 加新 category / Frequent 优先级规则改动时，本文件 case 翻红，
 * 强制两端同步。
 */

import { describe, it, expect } from 'vitest';
import {
  type VerifiedPart,
  FREQUENT_BUCKET,
  CATEGORY_ORDER,
  HIGH_PRIORITY_PARTS,
  computeBuckets,
  orderBucketNames,
  formatPortPlugLabel,
} from '../utils/partLibraryBuckets';

function part(id: string, category?: string): VerifiedPart {
  return { part_id: id, port_count: 0, mesh_url: '', category };
}

describe('computeBuckets — Frequent + category 分桶', () => {
  it('case 1: empty parts → empty buckets', () => {
    expect(computeBuckets([], {})).toEqual({});
  });

  it('case 2: HIGH_PRIORITY 部件无 usage 也进 Frequent + 进 category', () => {
    const parts = [part('2780.dat', 'Pin'), part('99999.dat', 'Pin')];
    const out = computeBuckets(parts, {});
    expect(out[FREQUENT_BUCKET]).toBeDefined();
    expect(out[FREQUENT_BUCKET].map(p => p.part_id)).toEqual(['2780.dat']);
    expect(out['Pin'].map(p => p.part_id).sort()).toEqual(['2780.dat', '99999.dat']);
  });

  it('case 3: usage > 0 部件进 Frequent，usage desc 排在 HIGH_PRIORITY 前', () => {
    const parts = [
      part('2780.dat', 'Pin'),    // HIGH_PRIORITY index=0, usage=0
      part('xxx.dat', 'Other'),   // 非 HIGH_PRIORITY, usage=5（应排第一）
    ];
    const out = computeBuckets(parts, { 'xxx.dat': 5 });
    expect(out[FREQUENT_BUCKET].map(p => p.part_id)).toEqual(['xxx.dat', '2780.dat']);
  });

  it('case 4: 同 usage 时 HIGH_PRIORITY index 决定顺序', () => {
    // HIGH_PRIORITY: 2780.dat(0), 3673.dat(1), 43093.dat(2)
    const parts = [
      part('43093.dat', 'Pin'),
      part('3673.dat', 'Pin'),
      part('2780.dat', 'Pin'),
    ];
    const out = computeBuckets(parts, {});
    expect(out[FREQUENT_BUCKET].map(p => p.part_id))
      .toEqual(['2780.dat', '3673.dat', '43093.dat']);
  });

  it('case 5: 同 usage + 都非 HIGH_PRIORITY → 按 part_id 字母序', () => {
    const parts = [
      part('zzz.dat', 'Other'),
      part('aaa.dat', 'Other'),
      part('mmm.dat', 'Other'),
    ];
    const out = computeBuckets(parts, { 'zzz.dat': 1, 'aaa.dat': 1, 'mmm.dat': 1 });
    expect(out[FREQUENT_BUCKET].map(p => p.part_id)).toEqual(['aaa.dat', 'mmm.dat', 'zzz.dat']);
  });

  it('case 6: 无 category 字段 → 兜到 Other 桶', () => {
    const parts = [part('xx.dat'), part('yy.dat', 'Pin')];
    const out = computeBuckets(parts, {});
    expect(out['Other'].map(p => p.part_id)).toEqual(['xx.dat']);
    expect(out['Pin'].map(p => p.part_id)).toEqual(['yy.dat']);
  });

  it('case 7: category 桶按 part_id 字母排序', () => {
    const parts = [
      part('zz.dat', 'Pin'),
      part('aa.dat', 'Pin'),
      part('mm.dat', 'Pin'),
    ];
    const out = computeBuckets(parts, {});
    expect(out['Pin'].map(p => p.part_id)).toEqual(['aa.dat', 'mm.dat', 'zz.dat']);
  });

  it('case 8: 没 Frequent 部件时 buckets 不含 Frequent 键', () => {
    const parts = [part('xxx.dat', 'Pin')];
    const out = computeBuckets(parts, {});
    expect(out[FREQUENT_BUCKET]).toBeUndefined();
    expect(Object.keys(out)).toEqual(['Pin']);
  });
});

describe('orderBucketNames — 渲染顺序', () => {
  it('case 9: Frequent 永远在最前，CATEGORY_ORDER 顺序保持', () => {
    const buckets = {
      Pin: [], Plate: [], Other: [],
      [FREQUENT_BUCKET]: [],
    };
    const ordered = orderBucketNames(buckets);
    expect(ordered[0]).toBe(FREQUENT_BUCKET);
    // Pin (index 0 in CATEGORY_ORDER) 比 Plate (index 6) 在前
    const pinIdx = ordered.indexOf('Pin');
    const plateIdx = ordered.indexOf('Plate');
    expect(pinIdx).toBeLessThan(plateIdx);
    // Other (index 15) 比 Plate (index 6) 在后
    expect(plateIdx).toBeLessThan(ordered.indexOf('Other'));
  });

  it('case 10: CATEGORY_ORDER 不含的未知桶按字母序兜到末尾', () => {
    const buckets = {
      Pin: [],
      ZUnknownCat: [],
      AUnknownCat: [],
    };
    const ordered = orderBucketNames(buckets);
    expect(ordered[0]).toBe('Pin'); // 已知 category 在前
    // 未知字母序：A 在 Z 前
    expect(ordered.indexOf('AUnknownCat')).toBeLessThan(ordered.indexOf('ZUnknownCat'));
  });

  it('case 11: empty buckets → empty array', () => {
    expect(orderBucketNames({})).toEqual([]);
  });

  it('case 12: CATEGORY_ORDER 完整契约 — 第 0 项是 Pin，最后一项是 Other', () => {
    // 后端 backend/category.py 漂移时 lock 住前后两端
    expect(CATEGORY_ORDER[0]).toBe('Pin');
    expect(CATEGORY_ORDER[CATEGORY_ORDER.length - 1]).toBe('Other');
  });

  it('case 13: HIGH_PRIORITY_PARTS 至少含 2780/3673/43093（核心销）', () => {
    expect(HIGH_PRIORITY_PARTS).toContain('2780.dat');
    expect(HIGH_PRIORITY_PARTS).toContain('3673.dat');
    expect(HIGH_PRIORITY_PARTS).toContain('43093.dat');
  });
});

describe('formatPortPlugLabel — 物料库卡片副标题（走法 A 期 A2 — 1c）', () => {
  it('case 14: 有 plug_count > 0 → "{port} ports · {plug} plugs"', () => {
    // 2x4 plate baseline：8 port / 2 plug
    expect(formatPortPlugLabel(8, 2)).toBe('8 ports · 2 plugs');
  });

  it('case 15: plug_count == port_count → 仍展示双数（销 baseline 2/2）', () => {
    // 销 (2780.dat) baseline：2 port / 2 plug
    expect(formatPortPlugLabel(2, 2)).toBe('2 ports · 2 plugs');
  });

  it('case 16: 9-hole 梁 baseline → 18 port / 1 plug（贯通孔合并）', () => {
    expect(formatPortPlugLabel(18, 1)).toBe('18 ports · 1 plugs');
  });

  it('case 17: plug_count undefined（老数据）→ 旧文案 fallback', () => {
    expect(formatPortPlugLabel(8, undefined)).toBe('8 Connection Ports');
  });

  it('case 18: plug_count == 0（装饰类零件）→ 旧文案 fallback', () => {
    // 显示卡片层应该过滤 0 端口；这里只验文案降级行为不抛错
    expect(formatPortPlugLabel(0, 0)).toBe('0 Connection Ports');
  });

  it('case 19: port == 0 + plug 缺 → 旧文案（向后兼容老数据）', () => {
    expect(formatPortPlugLabel(0)).toBe('0 Connection Ports');
  });
});

/**
 * partLibraryBuckets.ts
 * =====================
 * PartLibraryPanel 桶分类 + 排序的纯函数实现，从组件 useMemo 抽出来，
 * 让 vitest 单测可以直接验排序契约。组件层只负责把 props 传进来 + 调
 * computeBuckets / orderBucketNames，行为零变化。
 *
 * 类型 + 常量也在这里集中，避免组件文件成为单点 source of truth。
 */

export interface VerifiedPart {
  part_id: string;
  port_count: number;
  /** 走法 A 期 A2 — 1b：plug-level 抽象的 plug 总数（baked 自 plug_version=v1）*/
  plug_count?: number;
  mesh_url: string;
  // L50：backend categorize_part() 注入
  name?: string;
  // 中文名 / 描述：backend /api/get_verified_parts 从 part_names_zh.json 注入
  zh_name?: string;
  zh_desc?: string;
  category?: string;
  // L44：backend extract_tooth_count() 注入；非齿轮 / 异形齿轮 = null
  tooth_count?: number | null;
  // L51：backend mass_estimator 注入；GLB 没烘 = null
  mass_kg?: number | null;
  com_local?: [number, number, number] | null;
  // L51b：backend port_lib_manager.cached_data["bounding_box"] 注入；缺失 = null
  bbox_size?: [number, number, number] | null;
  bbox_center?: [number, number, number] | null;
}

export const FREQUENT_BUCKET = '★ Frequent';

// 与 backend/category.py 的 CATEGORY_ORDER 保持一致（出现顺序）。
// 注入新桶时两处必须同步，否则前端会把它兜到列表末尾。
export const CATEGORY_ORDER = [
  'Pin', 'Axle', 'Connector', 'Beam', 'Gear', 'Wheel',
  'Plate', 'Tile', 'Brick', 'Panel',
  'Cylinder', 'Pneumatic', 'Steering', 'Electric',
  'Sticker', 'Other',
] as const;

export const HIGH_PRIORITY_PARTS = [
  // 经典常用销 (Pins)
  '2780.dat',    // Blue friction pin (default color)
  '3673.dat',    // Light gray pin
  '43093.dat',   // Blue axle pin friction
  '11214.dat',   // 3L axle pin
  '6558.dat',    // 3L blue friction pin
  '32002.dat',   // 3/4 pin

  // 经典车轴 (Axles)
  '32062.dat',   // 2L notched axle (red)
  '4519.dat',    // 3L axle
  '3705.dat',    // 4L axle

  // 特殊件 / 电子件 / 大面板
  '10089c01.dat',// Motor
  '10090.dat',   // Motor / hub alternative
  '39369.dat',   // 11x19 Baseplate
  '71709.dat',   // Main hub or large panel
];

/**
 * 把 parts 切成 { '★ Frequent': [...], 'Pin': [...], ... }，仅含非空桶。
 *   - Frequent：partUsages>0 OR HIGH_PRIORITY；排序 usage desc → HIGH_PRIORITY index → part_id
 *   - 其他 category：parts 全员按 category 分桶；每桶按 part_id 字母序
 */
export function computeBuckets(
  parts: VerifiedPart[],
  partUsages: Record<string, number>,
): Record<string, VerifiedPart[]> {
  const out: Record<string, VerifiedPart[]> = {};
  const isHigh = (id: string) => HIGH_PRIORITY_PARTS.includes(id);

  const freq = parts
    .filter(p => (partUsages[p.part_id] || 0) > 0 || isHigh(p.part_id))
    .sort((a, b) => {
      const ua = partUsages[a.part_id] || 0;
      const ub = partUsages[b.part_id] || 0;
      if (ua !== ub) return ub - ua;
      const ia = HIGH_PRIORITY_PARTS.indexOf(a.part_id);
      const ib = HIGH_PRIORITY_PARTS.indexOf(b.part_id);
      if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.part_id.localeCompare(b.part_id);
    });
  if (freq.length > 0) out[FREQUENT_BUCKET] = freq;

  parts.forEach(p => {
    const cat = p.category || 'Other';
    if (!out[cat]) out[cat] = [];
    out[cat].push(p);
  });
  Object.keys(out).forEach(k => {
    if (k !== FREQUENT_BUCKET) {
      out[k].sort((a, b) => a.part_id.localeCompare(b.part_id));
    }
  });
  return out;
}

/**
 * 渲染顺序：Frequent 在最前；其余按 CATEGORY_ORDER 顺序；
 * CATEGORY_ORDER 不包含的未知桶按字母序兜底到末尾（向后兼容 backend 新加 category）。
 */
export function orderBucketNames(buckets: Record<string, VerifiedPart[]>): string[] {
  const known = [FREQUENT_BUCKET, ...CATEGORY_ORDER];
  const present = Object.keys(buckets);
  const ordered = known.filter(k => present.includes(k));
  const tail = present.filter(k => !known.includes(k)).sort();
  return [...ordered, ...tail];
}

/**
 * 走法 A 期 A2 — 1c：物料库卡片副标题文本。
 *
 * 有 plug_count（baked v1+）→ "{port} ports · {plug} plugs"
 *   把 plug-level 抽象暴露给选购阶段：用户在还没拖入场景前就能看到
 *   "这个 part 有 N 个独立接口聚合"，做更明智的搭配决策。
 *
 * 缺 plug_count（老数据 / 装饰类零件 plug_count==0）→ 旧文案
 *   "{port} Connection Ports"，行为零回归。
 *
 * 不在这层强约束 plugCount > 0；装饰类 0/0 调用方应过滤掉整张卡片。
 */
export function formatPortPlugLabel(
  portCount: number,
  plugCount?: number,
): string {
  if (plugCount != null && plugCount > 0) {
    return `${portCount} ports · ${plugCount} plugs`;
  }
  return `${portCount} Connection Ports`;
}

/**
 * turntableAssembly.ts
 * ====================
 * 「整体转盘」组合件：搜索/库里呈现为**一个**条目，放置时一次落下转盘顶 + 底座
 * 两半、预连成同轴 revolute（见 store.startFreePlacingTurntable）。用户当一个零件
 * 搜/放，落地即可相对旋转 / 被齿轮驱动。
 *
 * 要能相对旋转，内部必须仍是两个零件实例，故这里只做「呈现层」收敛：
 *   - 顶 = 触发组合放置的入口条目，显示名改「转盘…（整体）」
 *   - 底座 = 从搜索/库列表隐藏（仍是真实零件，引擎元数据照常）
 * 各对两半在 data/ldraw_port_configs.json 里均已加局部原点 hub 端口
 * （顶 turntable_pin / 底 turntable_socket），放同位即同轴扣合。
 */

interface TurntablePair {
  base: string;   // 底座 ldrawId（.dat）
  name: string;   // 顶条目的展示名
}

/** 顶 ldrawId(.dat) → { 底座, 展示名 }。新增成对的转盘只需在此登记。 */
const TURNTABLE_PAIRS: Record<string, TurntablePair> = {
  '18938.dat': { base: '18939.dat', name: '转盘 60齿（整体）' },
  '99010.dat': { base: '99009.dat', name: '转盘 28齿（整体）' },
  '2855.dat':  { base: '2856.dat',  name: '转盘 Type 1（整体）' },
  '48168.dat': { base: '48452.dat', name: '转盘 Type 2（整体）' },
  '32274.dat': { base: '32273.dat', name: '转盘 5×5（整体）' },
};

function normalizeId(id: string): string {
  if (!id) return '';
  return id.endsWith('.dat') ? id : id + '.dat';
}

const HIDDEN_BASE_IDS = new Set(Object.values(TURNTABLE_PAIRS).map(p => p.base));

/** 是否「整体转盘」的顶条目（触发组合放置）。 */
export function isTurntableAssemblyTop(partId: string): boolean {
  return normalizeId(partId) in TURNTABLE_PAIRS;
}

/** 从搜索/库列表隐藏的转盘底座（仍是真实零件，仅不单独陈列）。 */
export function isHiddenTurntableBase(partId: string): boolean {
  return HIDDEN_BASE_IDS.has(normalizeId(partId));
}

/** 顶条目对应的底座 ldrawId(.dat)；非顶条目返 null。 */
export function turntableBaseFor(partId: string): string | null {
  return TURNTABLE_PAIRS[normalizeId(partId)]?.base ?? null;
}

/** 组合件展示名（顶条目用）；非组合件返 null。 */
export function turntableAssemblyName(partId: string): string | null {
  return TURNTABLE_PAIRS[normalizeId(partId)]?.name ?? null;
}

/** 两个 ldrawId 是否构成「整体转盘」的顶↔底配对（顺序无关）。用于把已放下的
 *  两半在选择/移动/删除上绑成一个整体单元。 */
export function isTurntablePair(aLdrawId: string, bLdrawId: string): boolean {
  const a = normalizeId(aLdrawId);
  const b = normalizeId(bLdrawId);
  return TURNTABLE_PAIRS[a]?.base === b || TURNTABLE_PAIRS[b]?.base === a;
}

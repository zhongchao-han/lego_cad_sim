/**
 * turntableAssembly.ts
 * ====================
 * 「整体转盘」组合件：搜索/库里呈现为**一个**条目，放置时一次落下转盘顶 + 底座
 * 两半、预连成同轴 revolute（见 store.startFreePlacingTurntable）。用户当一个零件
 * 搜/放，落地即可相对旋转 / 被齿轮驱动。
 *
 * 要能相对旋转，内部必须仍是两个零件实例，故这里只做「呈现层」收敛：
 *   - 顶（18938）= 触发组合放置的入口条目，显示名改「转盘…（整体）」
 *   - 底座（18939）= 从搜索/库列表隐藏（仍是真实零件，引擎元数据照常）
 * 目前仅 60 齿（18938/18939，已加 hub 端口）支持；其余转盘需先补 hub 端口。
 */

function normalizeId(id: string): string {
  if (!id) return '';
  return id.endsWith('.dat') ? id : id + '.dat';
}

/** 触发「整体放置」的转盘顶 id。 */
const TURNTABLE_ASSEMBLY_TOP_IDS = new Set(['18938.dat']);
/** 从搜索/库列表隐藏的转盘底座 id（仍是真实零件，仅不单独陈列）。 */
const TURNTABLE_HIDDEN_BASE_IDS = new Set(['18939.dat']);

export function isTurntableAssemblyTop(partId: string): boolean {
  return TURNTABLE_ASSEMBLY_TOP_IDS.has(normalizeId(partId));
}

export function isHiddenTurntableBase(partId: string): boolean {
  return TURNTABLE_HIDDEN_BASE_IDS.has(normalizeId(partId));
}

/** 组合件显示名（顶条目用）；非组合件返 null。 */
export function turntableAssemblyName(partId: string): string | null {
  return isTurntableAssemblyTop(partId) ? '转盘 60齿（整体）' : null;
}

/**
 * freePlugs.ts
 * ============
 * 走法 A 期 A2 plug-level 派生视图 — 把"零件 plug 元数据 + 运行时
 * occupiedPorts" 派生为"plug 占用状态"。
 *
 * 核心契约：plug 不锁 atomicity（用户共识）—— partial 占用合法。所以
 * 派生视图不返"free / not free"二值，而是返带状态的 PlugStatus：
 *   - 'free'    → 全 N port 都未占（plug 完全可用）
 *   - 'partial' → 1..N-1 port 被占（剩余 port 仍可逐个用）
 *   - 'full'    → N port 全占（plug 没空位）
 *
 * 职责边界（跟 freePorts.ts 对称）：纯函数；不依赖 React / store / hook。
 * callsite 自己拉三路输入：
 *   - sites：useLDrawPart(partId).sites
 *   - plugs：useLDrawPart(partId).plugs
 *   - occupiedKeys：useStore(s => s.occupiedPorts[partId])
 */

import type { LDrawSite, LDrawPort, LDrawPlug } from '../useLDrawPart';
import { portKey } from '../store';
import type { Mat3, ZoneType } from '../types';

export type PlugStatusKind = 'free' | 'partial' | 'full';

export interface PlugStatus {
  plug: LDrawPlug;
  /** 仍未被占用的 port 数 */
  freePortCount: number;
  /** plug 总 port 数（== plug.port_count）*/
  totalPortCount: number;
  /** 派生状态 — UI 一眼看明白 */
  status: PlugStatusKind;
  /** 仍 free 的 portKey 列表，跟 occupiedPorts 同 key 域 */
  freePortKeys: string[];
}

/**
 * plug 占用状态计算。返回顺序跟 plugs 数组顺序一致。
 *
 * @param sites 用于 (site_id, port_idx) → port 解析
 * @param plugs 元数据中的 plug 列表
 * @param occupiedKeys partId 下的 portKey → peerPartId 映射（仅看 key 集合）
 */
export function computeFreePlugs(
  sites: LDrawSite[],
  plugs: LDrawPlug[],
  occupiedKeys: Record<string, string>,
): PlugStatus[] {
  const occupiedSet = new Set(Object.keys(occupiedKeys));
  // (site_id, port_idx) → port 索引，O(1) 解析 plug.members
  const portByMember = new Map<string, LDrawPort>();
  for (const site of sites) {
    site.ports.forEach((port, idx) => {
      portByMember.set(`${site.id}|${idx}`, port);
    });
  }

  const result: PlugStatus[] = [];
  for (const plug of plugs) {
    const freeKeys: string[] = [];
    for (const [siteId, portIdx] of plug.members) {
      const port = portByMember.get(`${siteId}|${portIdx}`);
      if (!port) continue;
      const k = portKey(port.position, port.rotation as Mat3);
      if (!occupiedSet.has(k)) {
        freeKeys.push(k);
      }
    }
    const total = plug.members.length;
    const free = freeKeys.length;
    const status: PlugStatusKind =
      free === total ? 'free' : free === 0 ? 'full' : 'partial';
    result.push({
      plug,
      freePortCount: free,
      totalPortCount: total,
      status,
      freePortKeys: freeKeys,
    });
  }
  return result;
}

/**
 * 装配体级聚合：所有 part 的 plug 状态合并。
 * 跟 computeAssemblyFreePorts 对称。
 *
 * @param partsMeta partId → { sites, plugs }（callsite 从 useLDrawPart 批量拉）
 * @param allOccupiedPorts 整个 store.occupiedPorts 字段
 * @returns partId → PlugStatus[]，仅含 plugs 非空的 part
 */
export function computeAssemblyFreePlugs(
  partsMeta: Record<string, { sites: LDrawSite[]; plugs: LDrawPlug[] }>,
  allOccupiedPorts: Record<string, Record<string, string>>,
): Record<string, PlugStatus[]> {
  const result: Record<string, PlugStatus[]> = {};
  for (const [partId, meta] of Object.entries(partsMeta)) {
    if (meta.plugs.length === 0) continue;
    const occupied = allOccupiedPorts[partId] ?? {};
    result[partId] = computeFreePlugs(meta.sites, meta.plugs, occupied);
  }
  return result;
}

/**
 * 装配体可用 plug 数的快速估算 — 不依赖 sites/plugs（不调 useLDrawPart），
 * 仅靠 store 已有字段：partCatalog.plugCount + portCount + occupiedPorts。
 *
 * 用例：StatusBar 概览（"Plugs: total / Free: K"）。Hook 限制让 StatusBar
 * 没法对每 part 调 useLDrawPart 拉 plugs；走估算路径。精确视图应走
 * computeFreePlugs（每 InteractivePart 已经持有 sites + plugs）。
 *
 * 估算公式（"非满 plug 数"下界 — 假设最坏聚集）：
 *   freePlugs ≈ plugCount - floor(occupiedCount × plugCount / portCount)
 *
 * 直观：occupied 全部 cluster 进同一组 plug 时，最多 floor(occupied / avg)
 * 个 plug 满；其余至少剩 1 port 可用 → 仍是"free 或 partial"。
 *
 * 例：2x4 plate (8 port, 2 plug，avg=4)：
 *   occupied=2 → 2 - floor(2*2/8) = 2 - 0 = 2  ✓ (全部 partial / free)
 *   occupied=4 → 2 - floor(4*2/8) = 2 - 1 = 1  (下界；实际可能仍是 2 partial)
 *   occupied=8 → 0  ✓ (全 full)
 *
 * 已知偏差：
 *   - portCount / plugCount 缺失 → 该 part 不计数
 *   - 估算下界 → 实际 free plug 数 ≥ 此值（用户感知偏保守）
 */
export function countAssemblyFreePlugsCheap(
  parts: Record<string, { ldrawId: string; zone: ZoneType }>,
  partCatalog: Record<string, {
    portCount?: number | null; plugCount?: number | null;
  }>,
  occupiedPorts: Record<string, Record<string, string>>,
  activeZone: ZoneType,
): number {
  let total = 0;
  for (const [partId, partState] of Object.entries(parts)) {
    if (partState.zone !== activeZone) continue;
    const meta = partCatalog[partState.ldrawId];
    const portCount = meta?.portCount ?? 0;
    const plugCount = meta?.plugCount ?? 0;
    if (portCount <= 0 || plugCount <= 0) continue;
    const occupiedCount = Object.keys(occupiedPorts[partId] ?? {}).length;
    const fullPlugsLB = Math.floor((occupiedCount * plugCount) / portCount);
    total += Math.max(0, plugCount - fullPlugsLB);
  }
  return total;
}

/**
 * 装配体 plug 总容量 — 单纯求和 ACTIVE_ARENA 内 plugCount。
 *
 * 用例：StatusBar "Plugs: <N>"（区别于"Free Plugs: K" — 总容量 vs 可用估算）。
 */
export function countAssemblyTotalPlugsCheap(
  parts: Record<string, { ldrawId: string; zone: ZoneType }>,
  partCatalog: Record<string, { plugCount?: number | null }>,
  activeZone: ZoneType,
): number {
  let total = 0;
  for (const partState of Object.values(parts)) {
    if (partState.zone !== activeZone) continue;
    const meta = partCatalog[partState.ldrawId];
    total += meta?.plugCount ?? 0;
  }
  return total;
}

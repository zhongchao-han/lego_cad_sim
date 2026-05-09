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
import type { Mat3 } from '../types';

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

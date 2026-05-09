/**
 * freePorts.ts
 * ============
 * 装配体派生视图层 (走法 A 期 A1)：把"零件元数据 sites/ports" + "运行时
 * occupiedPorts" 派生为"剩余可对外接的 ports"集合。
 *
 * 职责边界：纯函数；不依赖 React / store / hook。callsite 自己拉两路输入：
 *   - sites：来自 useLDrawPart(partId).sites（per-component 缓存）
 *   - occupiedKeys：来自 useStore(s => s.occupiedPorts[partId])
 *
 * 设计取舍：
 *   - 不在 zustand store 里 cache sites（partCatalog 不含 sites 数据，要扩字段
 *     就得动 schema；走纯函数避免侵入）
 *   - plug-level 聚合是后续 milestone (走法 A 期 A2)，本期仅 port-level
 */

import type { LDrawSite, LDrawPort } from '../useLDrawPart';
import { portKey } from '../store';
import type { Mat3, ZoneType } from '../types';

export interface FreePort {
  siteId: string;
  port: LDrawPort;
  /** portKey(port.position, port.rotation) 序列化结果，跟 occupiedPorts 同 key 域 */
  key: string;
}

/**
 * 返回零件上未被任何连接占用的 port 列表。
 *
 * @param sites useLDrawPart(partId).sites — LDraw 元数据派生的物理坑位聚类
 * @param occupiedKeys useStore(s => s.occupiedPorts[partId]) — 该零件上被
 *   ConnectionEdge 占用的 port key → peerPartId 映射；只看 key 集合，value
 *   不参与计算
 * @returns 顺序保证：跟 sites 数组 + 各 site.ports 数组顺序一致
 */
export function computeFreePorts(
  sites: LDrawSite[],
  occupiedKeys: Record<string, string>,
): FreePort[] {
  const occupiedSet = new Set(Object.keys(occupiedKeys));
  const result: FreePort[] = [];
  for (const site of sites) {
    for (const port of site.ports) {
      const k = portKey(port.position, port.rotation as Mat3);
      if (!occupiedSet.has(k)) {
        result.push({ siteId: site.id, port, key: k });
      }
    }
  }
  return result;
}

/**
 * 装配体级聚合：所有 part 的 freePorts 合并。
 *
 * @param partsWithSites partId → sites 映射（callsite 从 useLDrawPart 批量拉）
 * @param allOccupiedPorts 整个 store.occupiedPorts 字段
 * @returns partId → FreePort[]，仅含 freePorts 非空的 part
 */
export function computeAssemblyFreePorts(
  partsWithSites: Record<string, LDrawSite[]>,
  allOccupiedPorts: Record<string, Record<string, string>>,
): Record<string, FreePort[]> {
  const result: Record<string, FreePort[]> = {};
  for (const [partId, sites] of Object.entries(partsWithSites)) {
    const occupied = allOccupiedPorts[partId] ?? {};
    const free = computeFreePorts(sites, occupied);
    if (free.length > 0) {
      result[partId] = free;
    }
  }
  return result;
}

/**
 * 装配体可用 port 数的快速估算 — 不依赖 sites（不调 useLDrawPart），仅靠
 * store 已有字段：partCatalog.portCount（baked total）- occupiedPorts.length。
 *
 * 用例：StatusBar 顶部 lightweight 概览（"Free: X"）。Hook 限制让 StatusBar
 * 没法对每个 part 调 useLDrawPart 拉 sites（hook 数量必须稳定），所以走估算
 * 路径。精确视图应走 computeFreePorts（每 InteractivePart 已经持有 sites）。
 *
 * 已知不精确点：
 *   - 双面 connhole 在 portCount 里计 2，但占用通常只占一面 → free 估值
 *     稍偏大（用户感知层面通常仍合理：UI 上确实"另一面还能插"）。
 *   - portCount 缺失（partCatalog 未到位时）该 part 跳过不计数。
 */
export function countAssemblyFreePortsCheap(
  parts: Record<string, { ldrawId: string; zone: ZoneType }>,
  partCatalog: Record<string, { portCount?: number | null }>,
  occupiedPorts: Record<string, Record<string, string>>,
  activeZone: ZoneType,
): number {
  let total = 0;
  for (const [partId, partState] of Object.entries(parts)) {
    if (partState.zone !== activeZone) continue;
    const meta = partCatalog[partState.ldrawId];
    const portCount = meta?.portCount ?? null;
    if (portCount === null || portCount === undefined) continue;
    const occupiedCount = Object.keys(occupiedPorts[partId] ?? {}).length;
    total += Math.max(0, portCount - occupiedCount);
  }
  return total;
}

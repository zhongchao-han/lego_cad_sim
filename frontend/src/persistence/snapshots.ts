// Layer 1：命名快照 / 自动版本。
//
// 主工作区只有"当前"一份；快照是它的历史副本（带时间戳，保留最近 N 份）。
// 即便当前工作区被改坏 / 误清空 / 被覆盖，也能回滚到上一个完好版本——这是
// "草稿不丢"的最后一道本地防线（跨设备防线由 Layer 2 后端承担）。
//
// 快照内容直接拷贝主槽已落盘的字符串（zustand persist 序列化结果），因此与
// 内部序列化形状完全解耦：restore 时把它写回主槽并 reload，沿用现有 merge 反序列化。

import { SNAPSHOT_STORE, idbDel, idbGet, idbGetAll, idbSet } from './idb';
import { checksum, overwriteMain, readMain } from './safeStorage';

/** 保留的最大快照数；超出按时间最旧裁剪。 */
export const MAX_SNAPSHOTS = 30;

export interface SnapshotRecord {
  id: string;
  ts: number;
  label: string;
  /** 是否自动快照（true）还是用户手动命名（false）。 */
  auto: boolean;
  checksum: number;
  data: string;
}

/** 列表项（不含 data，避免一次性把全部副本读进内存）。 */
export interface SnapshotMeta {
  id: string;
  ts: number;
  label: string;
  auto: boolean;
  /** data 字节长度，给 UI 展示体量。 */
  size: number;
}

function newId(): string {
  return `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 抓一份当前主工作区快照。data 缺省取主槽已落盘内容。返回快照 id，无内容则 null。 */
export async function captureSnapshot(opts?: {
  label?: string;
  auto?: boolean;
  data?: string;
}): Promise<string | null> {
  const data = opts?.data ?? (await readMain());
  if (!data) return null;

  const rec: SnapshotRecord = {
    id: newId(),
    ts: Date.now(),
    label: opts?.label ?? '自动快照',
    auto: opts?.auto ?? true,
    checksum: checksum(data),
    data,
  };
  try {
    await idbSet(SNAPSHOT_STORE, rec);
    await pruneSnapshots();
  } catch {
    return null;
  }
  return rec.id;
}

/** 列出全部快照元信息，按时间倒序（最新在前）。 */
export async function listSnapshots(): Promise<SnapshotMeta[]> {
  let all: SnapshotRecord[] = [];
  try {
    all = await idbGetAll<SnapshotRecord>(SNAPSHOT_STORE);
  } catch {
    return [];
  }
  return all
    .map((r) => ({ id: r.id, ts: r.ts, label: r.label, auto: r.auto, size: r.data?.length ?? 0 }))
    .sort((a, b) => b.ts - a.ts);
}

/** 取某快照的数据并校验完整性；损坏返回 null。 */
export async function getSnapshotData(id: string): Promise<string | null> {
  let rec: SnapshotRecord | undefined;
  try {
    rec = await idbGet<SnapshotRecord>(SNAPSHOT_STORE, id);
  } catch {
    return null;
  }
  if (!rec || typeof rec.data !== 'string') return null;
  if (checksum(rec.data) !== rec.checksum) return null;
  return rec.data;
}

/** 把某快照恢复成当前工作区（写回主槽）。成功返回 true；调用方负责 reload。 */
export async function restoreSnapshot(id: string): Promise<boolean> {
  const data = await getSnapshotData(id);
  if (data === null) return false;
  await overwriteMain(data);
  return true;
}

export async function deleteSnapshot(id: string): Promise<void> {
  try {
    await idbDel(SNAPSHOT_STORE, id);
  } catch {
    /* 删除失败无害，忽略 */
  }
}

/** 裁剪：自动快照超出 MAX_SNAPSHOTS 时删最旧。手动命名的快照不参与自动裁剪。 */
export async function pruneSnapshots(max = MAX_SNAPSHOTS): Promise<void> {
  let all: SnapshotRecord[] = [];
  try {
    all = await idbGetAll<SnapshotRecord>(SNAPSHOT_STORE);
  } catch {
    return;
  }
  const autos = all.filter((r) => r.auto).sort((a, b) => a.ts - b.ts); // 旧→新
  const excess = autos.length - max;
  for (let i = 0; i < excess; i++) {
    await deleteSnapshot(autos[i].id);
  }
}

import React, { useCallback, useEffect, useState } from 'react';
import { History, X, Save, RotateCcw, Trash2, Cloud, HardDrive, RefreshCw } from 'lucide-react';
import { useStore } from '../store';
import {
  captureSnapshot,
  listSnapshots,
  restoreSnapshot,
  deleteSnapshot,
  type SnapshotMeta,
} from '../persistence/snapshots';
import {
  listBackendBuilds,
  pullFromBackend,
  getBuildId,
  getSyncState,
} from '../persistence/backendSync';

/**
 * DraftHistoryPanel — 草稿历史 / 恢复面板。
 *
 * 把三层持久化的「恢复」能力做成 UI：
 *  - 本地自动快照 + 手动命名快照（Layer 1）：列出、回滚、删除。
 *  - 云端备份（Layer 2 后端 SQLite）：列出全部已同步草稿（含其它设备），可拉回。
 * 恢复都先写回主槽再 reload，让 zustand persist 重新 hydrate。
 */

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return new Date(ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const DraftHistoryPanel: React.FC = () => {
  const show = useStore((s) => s.showDraftHistory);
  const toggle = useStore((s) => s.toggleDraftHistory);

  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  const [cloud, setCloud] = useState<{ id: string; updated_at: number; size: number }[]>([]);
  const [myBuildId, setMyBuildId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [s, c, id] = await Promise.all([listSnapshots(), listBackendBuilds(), getBuildId()]);
    setSnaps(s);
    setCloud(c.map((b) => ({ id: b.id, updated_at: b.updated_at * 1000, size: b.size })));
    setMyBuildId(id);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (show) void refresh();
  }, [show, refresh]);

  if (!show) return null;

  const saveNamed = async () => {
    const label = window.prompt('给这个快照起个名字：', `手动快照 ${new Date().toLocaleString()}`);
    if (label === null) return;
    setBusy(true);
    await captureSnapshot({ auto: false, label: label.trim() || '手动快照' });
    await refresh();
    setBusy(false);
  };

  const doRestoreSnapshot = async (id: string, label: string) => {
    if (!window.confirm(`恢复到「${label}」？当前工作区会被这份快照覆盖（覆盖前会自动先存一份）。`)) return;
    setBusy(true);
    // 覆盖前先把当前状态拍一份，避免误操作丢掉现在的进度。
    await captureSnapshot({ auto: false, label: '恢复前自动备份' });
    const ok = await restoreSnapshot(id);
    if (ok) {
      window.location.reload();
    } else {
      setBusy(false);
      window.alert('恢复失败：该快照可能已损坏。');
    }
  };

  const doDeleteSnapshot = async (id: string) => {
    setBusy(true);
    await deleteSnapshot(id);
    await refresh();
    setBusy(false);
  };

  const doPullCloud = async (id: string) => {
    const mine = id === myBuildId;
    if (!window.confirm(mine ? '从云端拉回本设备的备份并覆盖当前工作区？' : '从其它设备的云端备份拉回并覆盖当前工作区？')) return;
    setBusy(true);
    await captureSnapshot({ auto: false, label: '云端恢复前自动备份' });
    const ok = await pullFromBackend(id);
    if (ok) {
      window.location.reload();
    } else {
      setBusy(false);
      window.alert('拉取失败：后端可能未连接或该备份不存在。');
    }
  };

  const sync = getSyncState();

  return (
    <div className="fixed top-20 right-6 w-[420px] max-h-[72vh] bg-slate-900/95 backdrop-blur-xl border border-white/25 rounded-xl shadow-2xl flex flex-col overflow-hidden z-[1000] animate-in slide-in-from-top-5 pointer-events-auto">
      {/* Header */}
      <div className="bg-white/10 border-b border-white/20 px-3 py-2.5 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <History size={18} className="text-sky-400" />
          <span className="text-base font-bold text-white tracking-wide">草稿历史</span>
          <span
            className={`flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${
              sync.dirty ? 'bg-amber-500/25 text-amber-200' : 'bg-emerald-500/25 text-emerald-200'
            }`}
            title={sync.dirty ? '有改动尚未同步到云端' : '已同步到云端'}
          >
            <Cloud size={12} />
            {sync.dirty ? '待同步' : '已同步'}
          </span>
        </div>
        <div className="flex items-center space-x-1">
          <button onClick={() => void refresh()} className="p-1.5 hover:bg-white/20 rounded-md text-slate-300 hover:text-white transition-colors" title="刷新">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => toggle(false)} className="p-1.5 hover:bg-white/20 rounded-md text-slate-300 hover:text-white transition-colors" title="关闭">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Action */}
      <div className="px-3 py-2.5 border-b border-white/10">
        <button
          onClick={() => void saveNamed()}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white shadow-lg shadow-sky-900/40 transition-colors disabled:opacity-50"
        >
          <Save size={16} /> 保存命名快照
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5 scrollbar-thin scrollbar-thumb-white/10">
        {/* 本地快照 */}
        <section>
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">
            <HardDrive size={14} /> 本地快照
            {snaps.length > 0 && <span className="text-slate-400 normal-case">（{snaps.length}）</span>}
          </div>
          {snaps.length === 0 ? (
            <p className="text-xs text-slate-400 italic py-2">还没有快照。搭建过程中会自动定期保存。</p>
          ) : (
            <ul className="space-y-1.5 max-h-[38vh] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10">
              {snaps.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-slate-50 truncate">{s.label}</span>
                      {!s.auto && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/30 text-sky-200 shrink-0">手动</span>}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{relTime(s.ts)} · {fmtSize(s.size)}</div>
                  </div>
                  <button onClick={() => void doRestoreSnapshot(s.id, s.label)} disabled={busy}
                    className="p-2 rounded-md text-slate-300 hover:bg-sky-500/30 hover:text-sky-200 transition-colors disabled:opacity-40" title="恢复到此快照">
                    <RotateCcw size={16} />
                  </button>
                  <button onClick={() => void doDeleteSnapshot(s.id)} disabled={busy}
                    className="p-2 rounded-md text-slate-300 hover:bg-rose-500/30 hover:text-rose-200 transition-colors disabled:opacity-40" title="删除快照">
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 云端备份 */}
        <section>
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">
            <Cloud size={14} /> 云端备份（跨设备）
            {cloud.length > 0 && <span className="text-slate-400 normal-case">（{cloud.length}）</span>}
          </div>
          {cloud.length === 0 ? (
            <p className="text-xs text-slate-400 italic py-2">暂无云端备份（后端未连接或还没同步）。</p>
          ) : (
            <ul className="space-y-1.5 max-h-[38vh] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10">
              {cloud.map((b) => (
                <li key={b.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-slate-50 truncate font-mono">{b.id.slice(0, 18)}</span>
                      {b.id === myBuildId && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/30 text-emerald-200 shrink-0">本设备</span>}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{relTime(b.updated_at)} · {fmtSize(b.size)}</div>
                  </div>
                  <button onClick={() => void doPullCloud(b.id)} disabled={busy}
                    className="p-2 rounded-md text-slate-300 hover:bg-sky-500/30 hover:text-sky-200 transition-colors disabled:opacity-40" title="拉回此备份">
                    <RotateCcw size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

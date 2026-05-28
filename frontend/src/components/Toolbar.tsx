import { useMemo, type ComponentType } from 'react';
import {
  RotateCcw, RotateCw, FlipVertical2, Copy, Trash2,
  Undo2, Redo2, Search, Zap, Unlink, Link2, History,
} from 'lucide-react';
import { useStore } from '../store';
import { InteractionPhase } from '../types';
import { getCameraGroundAxes, screenSpinAxisAngle } from '../utils/cameraGroundAxes';

/**
 * Toolbar — 顶部固定工具栏（UX 反馈：让用户一眼看到有哪些功能 + 快捷键，也能直接点）。
 *
 * - 选中件操作（旋转/翻面/复制/删除）：仅 IDLE+选中时可用，否则灰显 disabled。
 * - 历史（撤销/重做）：按 canUndo/canRedo 灰显。
 * - 全局（搜索/受力可视化）：常驻。
 * - 每个按钮都标注快捷键（图标下小字 + tooltip 全名）。
 *
 * 注：零件颜色按惯例全锁（见 partColorDefaults.ts），无改色入口。
 */
export function Toolbar() {
  const interactionPhase = useStore((s) => s.interactionPhase);
  const primaryId = useStore((s) => s.selection.primaryId);
  const allConnectedIds = useStore((s) => s.selection.allConnectedIds);
  const parts = useStore((s) => s.parts);
  const connections = useStore((s) => s.connections);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const showReactionForces = useStore((s) => s.showReactionForces);

  const rotateSelectedSingle = useStore((s) => s.rotateSelectedSingle);
  const flipSelected = useStore((s) => s.flipSelected);
  const duplicateSelected = useStore((s) => s.duplicateSelected);
  const deleteSelected = useStore((s) => s.deleteSelected);
  const detachSelected = useStore((s) => s.detachSelected);
  const relatchScene = useStore((s) => s.relatchScene);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const setShowReactionForces = useStore((s) => s.setShowReactionForces);
  const showDraftHistory = useStore((s) => s.showDraftHistory);
  const toggleDraftHistory = useStore((s) => s.toggleDraftHistory);

  const hasSel = interactionPhase === InteractionPhase.IDLE && primaryId !== null;

  // [/] 与按钮同一套：绕「最接近视线的世界轴」做屏幕平面顺/逆时针自转（看哪个面就转哪个面）。
  const spinSelected = (screen: 'cw' | 'ccw') => {
    const { axis, angle } = screenSpinAxisAngle(screen, Math.PI / 2, getCameraGroundAxes());
    rotateSelectedSingle(axis, angle);
  };

  const selectedIds = useMemo(
    () => (allConnectedIds.length > 0 ? allConnectedIds : primaryId ? [primaryId] : []),
    [allConnectedIds, primaryId],
  );

  // 脱开仅在「选区与外部存在连接」时可用（否则没有可切断的边）。整组全选 → 无跨界边 → 灰显。
  const canDetach = useMemo(() => {
    if (!hasSel) return false;
    const sel = new Set(selectedIds);
    return selectedIds.some((id) => {
      const peers = connections[id];
      if (!peers) return false;
      for (const p of peers) if (!sel.has(p)) return true;
      return false;
    });
  }, [hasSel, selectedIds, connections]);

  return (
    <div
      data-testid="toolbar"
      className="pointer-events-auto flex items-center gap-0.5 bg-white/85 backdrop-blur-md
                 px-2 py-1.5 rounded-2xl shadow-xl border border-white/20 relative"
    >
      <ToolBtn icon={RotateCcw} label="逆时针旋转 90°" kbd="[" disabled={!hasSel}
        onClick={() => spinSelected('ccw')} testid="tb-rotate-ccw" />
      <ToolBtn icon={RotateCw} label="顺时针旋转 90°" kbd="]" disabled={!hasSel}
        onClick={() => spinSelected('cw')} testid="tb-rotate-cw" />
      <ToolBtn icon={FlipVertical2} label="翻面 180°" kbd="⇧F" disabled={!hasSel}
        onClick={() => flipSelected()} testid="tb-flip" />

      <ToolBtn icon={Copy} label="复制" kbd="Ctrl+D" disabled={!hasSel}
        onClick={() => duplicateSelected()} testid="tb-duplicate" />
      <ToolBtn icon={Unlink} label="脱开（从装配中分离选中件）" kbd="" disabled={!canDetach}
        onClick={() => detachSelected()} testid="tb-detach" />
      <ToolBtn icon={Trash2} label="删除" kbd="Del" disabled={!hasSel} danger
        onClick={() => deleteSelected()} testid="tb-delete" />

      <Divider />

      <ToolBtn icon={Undo2} label="撤销" kbd="Ctrl+Z" disabled={!canUndo}
        onClick={() => undo()} testid="tb-undo" />
      <ToolBtn icon={Redo2} label="重做" kbd="Ctrl+⇧Z" disabled={!canRedo}
        onClick={() => redo()} testid="tb-redo" />

      <Divider />

      <ToolBtn icon={Link2} label="检测并连接（把已插入但未连接的端口连起来）" kbd=""
        disabled={Object.keys(parts).length < 2}
        onClick={() => { void relatchScene(); }} testid="tb-relatch" />
      <ToolBtn icon={Search} label="搜索零件" kbd="Ctrl+K"
        onClick={() => setSearchOpen(true)} testid="tb-search" />
      <ToolBtn icon={Zap} label="受力可视化" kbd="" active={showReactionForces}
        onClick={() => setShowReactionForces(!showReactionForces)} testid="tb-forces" />
      <ToolBtn icon={History} label="草稿历史（自动快照 / 跨设备恢复）" kbd="" active={showDraftHistory}
        onClick={() => toggleDraftHistory()} testid="tb-draft-history" />
    </div>
  );
}

function Divider() {
  return <div className="w-px h-7 bg-slate-200 mx-1" />;
}

interface ToolBtnProps {
  icon: ComponentType<{ size?: number }>;
  label: string;
  kbd: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  testid?: string;
}

// 纯图标按钮：快捷键只在 hover tooltip 里显示（不在图标下重复写）；图标放大更清晰（UX 反馈）。
function ToolBtn({ icon: Icon, label, kbd, onClick, disabled, active, danger, testid }: ToolBtnProps) {
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={disabled}
      title={kbd ? `${label} (${kbd})` : label}
      onClick={onClick}
      className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors select-none
        ${disabled
          ? 'text-slate-300 cursor-not-allowed'
          : active
            ? 'bg-blue-100 text-blue-700'
            : danger
              ? 'text-slate-600 hover:bg-rose-50 hover:text-rose-600'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
    >
      <Icon size={22} />
    </button>
  );
}

import { useState, useEffect, useMemo, type ComponentType } from 'react';
import {
  RotateCcw, RotateCw, FlipVertical2, Palette, Copy, Trash2,
  Undo2, Redo2, Search, Zap, Unlink, Link2,
} from 'lucide-react';
import { useStore } from '../store';
import { InteractionPhase } from '../types';
import { LEGO_PALETTE } from '../utils/legoPalette';
import { hasPresetColor } from '../utils/partColorDefaults';

/**
 * Toolbar — 顶部固定工具栏（UX 反馈：让用户一眼看到有哪些功能 + 快捷键，也能直接点）。
 *
 * - 选中件操作（旋转/翻面/改色/复制/删除）：仅 IDLE+选中时可用，否则灰显 disabled。
 * - 历史（撤销/重做）：按 canUndo/canRedo 灰显。
 * - 全局（搜索/受力可视化）：常驻。
 * - 每个按钮都标注快捷键（图标下小字 + tooltip 全名）。
 * - 「改色」点开弹出色板（并入工具栏，复用 recolorSelected；功能件锁色）。
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
  const recolorSelected = useStore((s) => s.recolorSelected);

  const [recolorOpen, setRecolorOpen] = useState(false);

  const hasSel = interactionPhase === InteractionPhase.IDLE && primaryId !== null;

  const selectedIds = useMemo(
    () => (allConnectedIds.length > 0 ? allConnectedIds : primaryId ? [primaryId] : []),
    [allConnectedIds, primaryId],
  );
  const recolorable = useMemo(
    () => selectedIds.filter((id) => parts[id] && !hasPresetColor(parts[id].ldrawId)),
    [selectedIds, parts],
  );
  const currentColor = recolorable.length === 1 ? parts[recolorable[0]]?.colorCode ?? null : null;

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

  // 失去选中 / 离开 IDLE → 收起改色弹窗。
  useEffect(() => { if (!hasSel) setRecolorOpen(false); }, [hasSel]);

  return (
    <div
      data-testid="toolbar"
      className="pointer-events-auto flex items-center gap-0.5 bg-white/85 backdrop-blur-md
                 px-2 py-1.5 rounded-2xl shadow-xl border border-white/20 relative"
    >
      <ToolBtn icon={RotateCcw} label="逆时针旋转 90°" kbd="[" disabled={!hasSel}
        onClick={() => rotateSelectedSingle(-Math.PI / 2)} testid="tb-rotate-ccw" />
      <ToolBtn icon={RotateCw} label="顺时针旋转 90°" kbd="]" disabled={!hasSel}
        onClick={() => rotateSelectedSingle(Math.PI / 2)} testid="tb-rotate-cw" />
      <ToolBtn icon={FlipVertical2} label="翻面 180°" kbd="⇧F" disabled={!hasSel}
        onClick={() => flipSelected()} testid="tb-flip" />

      {/* 改色：点开弹出色板 */}
      <div className="relative">
        <ToolBtn icon={Palette} label="改色" kbd="" disabled={!hasSel} active={recolorOpen}
          onClick={() => setRecolorOpen((o) => !o)} testid="tb-recolor" />
        {recolorOpen && hasSel && (
          <div
            data-testid="recolor-palette"
            className="absolute top-full mt-2 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1.5
                       px-3 py-2 rounded-xl bg-slate-900/95 border border-slate-700 shadow-2xl"
          >
            {recolorable.length === 0 ? (
              <span className="text-[11px] text-amber-400 whitespace-nowrap select-none">功能件颜色锁定，不可改</span>
            ) : (
              LEGO_PALETTE.map(({ code, hex, name }) => (
                <button
                  key={code}
                  type="button"
                  data-testid={`recolor-swatch-${code}`}
                  title={`${name} (LDraw #${code})`}
                  onClick={() => { recolorSelected(code); }}
                  style={{ backgroundColor: hex }}
                  className={`w-6 h-6 rounded-full shrink-0 transition-all duration-150
                    ${code === currentColor
                      ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-slate-900 scale-110'
                      : 'hover:scale-110 opacity-85 hover:opacity-100'}
                    ${hex === '#FFFFFF' ? 'border border-slate-400' : ''}`}
                />
              ))
            )}
          </div>
        )}
      </div>

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

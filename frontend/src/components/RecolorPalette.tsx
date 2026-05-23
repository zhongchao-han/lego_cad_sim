import { useMemo } from 'react';
import { useStore } from '../store';
import { InteractionPhase } from '../types';
import { LEGO_PALETTE } from '../utils/legoPalette';
import { hasPresetColor } from '../utils/partColorDefaults';

/**
 * RecolorPalette — 已放置零件改色（UX 反馈）。
 *
 * 交互：IDLE 下选中零件（或多选）→ 浮出此色板，点色卡即给选中件改色（可撤销）。
 * 作用范围 = selection.allConnectedIds；功能预设色件（销/轴）锁色跳过。
 * 与 PartPreviewOverlay 的"放置前选色"区分：那个设画笔色（新件），这个改已放置件。
 */
export function RecolorPalette() {
  const interactionPhase = useStore((s) => s.interactionPhase);
  const primaryId = useStore((s) => s.selection.primaryId);
  const allConnectedIds = useStore((s) => s.selection.allConnectedIds);
  const parts = useStore((s) => s.parts);
  const recolorSelected = useStore((s) => s.recolorSelected);

  // 选中件集合（INDIVIDUAL 单选 = [primaryId]；多选 = allConnectedIds）。
  const selectedIds = useMemo(
    () => (allConnectedIds.length > 0 ? allConnectedIds : primaryId ? [primaryId] : []),
    [allConnectedIds, primaryId],
  );

  // 可改色件（排除功能预设色件）。
  const recolorable = useMemo(
    () => selectedIds.filter((id) => parts[id] && !hasPresetColor(parts[id].ldrawId)),
    [selectedIds, parts],
  );

  // 单选时当前色 → 高亮对应色卡。
  const currentColor = useMemo(() => {
    if (recolorable.length !== 1) return null;
    return parts[recolorable[0]]?.colorCode ?? null;
  }, [recolorable, parts]);

  // 仅在 IDLE + 有选中件时显示。
  if (interactionPhase !== InteractionPhase.IDLE || primaryId === null) return null;

  const allLocked = recolorable.length === 0;

  return (
    <div
      data-testid="recolor-palette"
      className="absolute bottom-9 left-1/2 -translate-x-1/2 pointer-events-auto z-[55]
                 flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/95 border border-slate-700 shadow-2xl"
    >
      <span className="text-[11px] font-mono text-slate-300 mr-1 select-none">改色</span>
      {allLocked ? (
        <span className="text-[11px] text-amber-400 select-none">功能件颜色锁定，不可改</span>
      ) : (
        LEGO_PALETTE.map(({ code, hex, name }) => {
          const isActive = code === currentColor;
          return (
            <button
              key={code}
              type="button"
              data-testid={`recolor-swatch-${code}`}
              title={`${name} (LDraw #${code})`}
              onClick={() => recolorSelected(code)}
              style={{ backgroundColor: hex }}
              className={`w-6 h-6 rounded-full shrink-0 transition-all duration-150
                ${isActive
                  ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-slate-900 scale-110'
                  : 'hover:scale-110 opacity-85 hover:opacity-100'}
                ${hex === '#FFFFFF' ? 'border border-slate-400' : ''}`}
            />
          );
        })
      )}
    </div>
  );
}

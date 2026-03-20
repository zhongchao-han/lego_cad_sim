import { useStore } from '../store';
import { Package, Trash2, ArrowLeftCircle } from 'lucide-react';

export function StagingTrayPanel() {
  const stagingGrid = useStore((s) => s.stagingGrid);
  const parts = useStore((s) => s.parts);
  const previewPart = useStore((s) => s.previewPart);
  const previewPartId = useStore((s) => s.previewPartId);

  return (
    <div className="flex flex-col h-full bg-slate-900/10 backdrop-blur-md border-l shadow-2xl w-72 pointer-events-auto overflow-hidden transition-all text-slate-800">
      {/* 头部：暂存区标题 */}
      <div className="p-4 border-b bg-white/40 flex items-center justify-between">
        <h2 className="text-sm font-black text-slate-800 flex items-center gap-2 uppercase tracking-widest">
          <Package className="w-5 h-5 text-blue-600" />
          Parts Staging Tray
        </h2>
        <div className="text-[10px] bg-blue-100 text-blue-700 font-bold px-2 py-0.5 rounded-full">
          {stagingGrid.slots.filter(s => s.occupiedBy).length} / {stagingGrid.slots.length}
        </div>
      </div>

      {/* 垂直列表布局: 精准对齐库样式 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {stagingGrid.slots.every(s => !s.occupiedBy) ? (
          <div className="text-center py-20 px-6">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3 opacity-50">
               <Package className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Tray is empty</p>
            <p className="text-[10px] text-slate-300 mt-1 italic">Double-click a part in the scene to stage it here.</p>
          </div>
        ) : (
          stagingGrid.slots.map((slot) => {
            const partId = slot.occupiedBy;
            const part = partId ? parts[partId] : null;
            if (!part) return null; // 列表模式下不显示空槽位，以保持紧凑 (类似已选列表)

            return (
              <button
                key={slot.index}
                onClick={() => partId && previewPart(partId)}
                className={`w-full group flex items-center gap-3 p-3 rounded-lg transition-all text-left border ${
                  previewPartId === partId 
                    ? 'bg-blue-50 border-blue-200 shadow-sm' 
                    : 'bg-white border-transparent hover:bg-white/80 hover:border-slate-200'
                }`}
              >
                <div className="w-12 h-12 bg-slate-100 rounded border border-slate-200 flex items-center justify-center overflow-hidden shrink-0">
                   <Package className={`w-6 h-6 transition-colors ${previewPartId === partId ? 'text-blue-500' : 'text-slate-300 group-hover:text-blue-400'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-slate-700 truncate">
                    {part.ldrawId.replace('.dat', '')}
                  </div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
                    INSTANCE: {partId.slice(-4).toUpperCase()}
                  </div>
                </div>
                {previewPartId === partId && (
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
                )}
              </button>
            );
          })
        )}
      </div>

      <div className="p-4 bg-white/20 border-t">
          <p className="text-[10px] text-slate-500 leading-relaxed font-semibold">
             Parts detached from assembly will appear here. Click a slot to re-assemble.
          </p>
      </div>
    </div>
  );
}

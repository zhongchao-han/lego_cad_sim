/**
 * PartLibraryPanel.tsx
 * ====================
 * 零件物料库面板。
 *
 * 交互逻辑（Why）：
 *   乐高 Technic 零件的颜色并非由图纸决定，而是由使用者指定的 color_code 在
 *   GLB 生成时烘焙进去的。为了提供直觉正确的体验：
 *
 *   1. 高频经典零件（如蓝销、红轴）自动预设默认颜色，用户无需手选。
 *   2. 面板头部提供"画笔颜色"选择器，用于覆盖默认色或为未知零件选色。
 *   3. 用户在点击零件时，优先取经典颜色字典命中值，次选"画笔颜色"。
 *
 * 颜色流向（从选择器到 GLB）：
 *   用户选色 → activeColorCode (Store) →
 *   零件 click → getDefaultColorCode(partId, activeColorCode) →
 *   PartState.colorCode → useLDrawPart(partId, colorCode) →
 *   GET /api/ldraw_part/:id?color=N → GeometryProcessor bakles GLB with vertex colors
 */

import { useEffect, useState } from 'react';
import axios from 'axios';
import { useStore } from '../store';
import { Search, Box, ChevronRight } from 'lucide-react';
import { getDefaultColorCode } from '../utils/partColorDefaults';

const BACKEND_ORIGIN: string = ((import.meta as unknown as Record<string, Record<string, string>>).env?.['VITE_BACKEND_ORIGIN']) || 'http://127.0.0.1:8000';

interface VerifiedPart {
  part_id: string;
  port_count: number;
  mesh_url: string;
}

export function PartLibraryPanel() {
  const [parts, setParts] = useState<VerifiedPart[]>([]);
  const [loading, setLoading] = useState(true);

  const previewPart = useStore((s) => s.previewPart);
  const previewPartId = useStore((s) => s.previewPartId);

  useEffect(() => {
    const fetchParts = async () => {
      try {
        const res = await axios.get(`${BACKEND_ORIGIN}/api/get_verified_parts`);
        setParts(res.data);
      } catch (err) {
        console.error('Failed to fetch verified parts:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchParts();
  }, []);

  return (
    <div className="flex flex-col h-full bg-white/90 backdrop-blur-md border-r shadow-xl w-72 pointer-events-auto overflow-hidden transition-all">
      {/* 标题栏 */}
      <div className="p-4 border-b bg-slate-50">
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
          <Box className="w-5 h-5 text-blue-600" />
          Material Library
        </h2>



        {/* 搜索框 (点击呼出全局全量级 Semantic Search 面板) */}
        <div className="relative mt-3">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            readOnly
            placeholder="Search parts (Cmd+K)..."
            className="w-full pl-9 pr-4 py-2 text-sm bg-slate-100 border border-slate-200 rounded-md cursor-pointer hover:bg-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-500 font-medium tracking-wide"
            onClick={() => window.dispatchEvent(new CustomEvent('open-part-search'))}
          />
        </div>
      </div>

      {/* 零件列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2 opacity-50">
             <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
             <span className="text-xs font-medium">Loading catalog...</span>
          </div>
        ) : parts.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            No verified parts found.
          </div>
        ) : (
          parts.map((part) => {
            // 预显示该零件默认颜色（根据字典，不传 fallback）
            // 我们在库列表中仅显示经典颜色的角标提示
            const resolvedColor = getDefaultColorCode(part.part_id, 71); // 71 为无命中时的占位灰
            const isAutoColor = resolvedColor !== 71;

            return (
              <button
                key={part.part_id}
                onClick={() => previewPart(part.part_id)}
                className={`w-full group flex items-center gap-3 p-3 rounded-lg transition-all text-left border ${
                  previewPartId === part.part_id
                    ? 'bg-blue-50 border-blue-200 shadow-sm'
                    : 'bg-white border-transparent hover:bg-slate-50 hover:border-slate-100'
                }`}
              >
                <div className="relative w-12 h-12 bg-slate-100 rounded border border-slate-200 flex items-center justify-center overflow-hidden shrink-0">
                  <img 
                    src={`${BACKEND_ORIGIN}/api/thumbnails/${part.part_id.replace('.dat', '.png')}`}
                    alt={part.part_id}
                    className="w-10 h-10 object-contain transition-transform group-hover:scale-110"
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                      if (e.currentTarget.nextElementSibling) {
                        (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'block';
                      }
                    }}
                  />
                  <Box className="w-6 h-6 text-slate-300 transition-colors group-hover:text-blue-400" style={{ display: 'none' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-700 truncate">
                    {part.part_id.replace('.dat', '')}
                  </div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                    {part.port_count} Connection Ports
                  </div>
                  {isAutoColor && (
                    <div className="text-[9px] text-amber-500 font-bold tracking-wide mt-0.5">
                      ⚡ PRESET COLOR
                    </div>
                  )}
                </div>
                <ChevronRight className={`w-4 h-4 text-slate-300 transition-transform ${
                  previewPartId === part.part_id ? 'translate-x-1 text-blue-500' : 'group-hover:translate-x-1'
                }`} />
              </button>
            );
          })
        )}
      </div>

      <div className="p-3 border-t bg-slate-50 text-[10px] text-slate-400 text-center italic">
        Select a part to preview and pick connection port.
      </div>
    </div>
  );
}

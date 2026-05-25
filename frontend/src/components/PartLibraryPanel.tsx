/**
 * PartLibraryPanel.tsx
 * ====================
 * 零件物料库面板（L50 分级目录版本）。
 *
 * 历史交互逻辑（保留）：
 *   乐高 Technic 零件的颜色并非由图纸决定，而是由使用者指定的 color_code 在
 *   GLB 生成时烘焙进去的。1) 高频经典零件预设默认颜色；2) 头部"画笔颜色"覆盖；
 *   3) 优先取经典颜色字典命中值。
 *
 * L50 改动：把扁平 1900+ 卡片列表换成可折叠分级面板。
 *   - 顶部 "★ Frequent" 桶：本会话用过的 OR HIGH_PRIORITY_PARTS，默认展开
 *   - 后续按 CATEGORY_ORDER 渲染 backend 推断的 category（默认折叠以避免视觉过载）
 *   - 每个 category 标题带计数；点击 chevron 展开/收起
 *   - category 字段由 /api/get_verified_parts 通过 backend/category.py 启发式注入
 */

import { useEffect, useState, useMemo } from 'react';
import axios from 'axios';
import { useStore } from '../store';
import { Search, Box, ChevronRight, ChevronDown, Star } from 'lucide-react';
import { getDefaultColorCode } from '../utils/partColorDefaults';
import {
  type VerifiedPart,
  FREQUENT_BUCKET,
  computeBuckets,
  orderBucketNames,
  formatPortPlugLabel,
} from '../utils/partLibraryBuckets';

const BACKEND_ORIGIN: string = ((import.meta as unknown as Record<string, Record<string, string>>).env?.['VITE_BACKEND_ORIGIN']) || 'http://127.0.0.1:8000';

export function PartLibraryPanel() {
  const [parts, setParts] = useState<VerifiedPart[]>([]);
  const [loading, setLoading] = useState(true);
  // 折叠态：默认仅 Frequent 展开。用户偏好不持久化（v1）。
  const [openBuckets, setOpenBuckets] = useState<Set<string>>(new Set([FREQUENT_BUCKET]));

  const previewPart = useStore((s) => s.previewPart);
  const previewPartId = useStore((s) => s.previewPartId);
  const partUsages = useStore((s) => s.partUsages);
  const setPartCatalog = useStore((s) => s.setPartCatalog);
  const setSearchOpen = useStore((s) => s.setSearchOpen);

  useEffect(() => {
    const fetchParts = async () => {
      try {
        const res = await axios.get(`${BACKEND_ORIGIN}/api/get_verified_parts`);
        const data: VerifiedPart[] = res.data;
        setParts(data);
        // L44 / L50：把后端返回的 name / category / tooth_count 元数据填进 store，
        // 让 snapParts 等不再触达 PartLibraryPanel 也能查 ldrawId 元数据。
        const catalog: Record<string, import('../types').PartCatalogEntry> = {};
        data.forEach(p => {
          catalog[p.part_id] = {
            partId:     p.part_id,
            name:       p.name ?? p.part_id,
            category:   p.category ?? 'Other',
            toothCount: p.tooth_count ?? null,
            massKg:     p.mass_kg ?? null,
            comLocal:   p.com_local ?? null,
            bboxSize:   p.bbox_size ?? null,
            bboxCenter: p.bbox_center ?? null,
            portCount:  p.port_count,
            plugCount:  p.plug_count,
            meshUrl:    p.mesh_url,
          };
        });
        setPartCatalog(catalog);
      } catch (err) {
        console.error('Failed to fetch verified parts:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchParts();
  }, [setPartCatalog]);

  // 桶分类 + 排序逻辑见 utils/partLibraryBuckets.ts；这里仅负责把 props 喂进去 + useMemo 缓存。
  const buckets = useMemo(() => computeBuckets(parts, partUsages), [parts, partUsages]);
  const orderedBucketNames = useMemo(() => orderBucketNames(buckets), [buckets]);

  const toggleBucket = (name: string) => {
    setOpenBuckets(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

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
            onClick={() => setSearchOpen(true)}
          />
        </div>
      </div>

      {/* 分级目录 */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
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
          orderedBucketNames.map(bucketName => {
            const items = buckets[bucketName];
            if (!items || items.length === 0) return null;
            const isOpen = openBuckets.has(bucketName);
            const isFrequent = bucketName === FREQUENT_BUCKET;

            return (
              <div key={bucketName} className="border-b border-slate-100 last:border-b-0">
                {/* 桶标题 */}
                <button
                  type="button"
                  onClick={() => toggleBucket(bucketName)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${
                    isFrequent ? 'bg-amber-50 hover:bg-amber-100' : 'bg-slate-50 hover:bg-slate-100'
                  }`}
                >
                  {isOpen
                    ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
                  {isFrequent && <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400 shrink-0" />}
                  <span className={`text-xs font-bold uppercase tracking-wider ${
                    isFrequent ? 'text-amber-700' : 'text-slate-700'
                  }`}>
                    {isFrequent ? 'Frequent' : bucketName}
                  </span>
                  <span className="ml-auto text-[10px] text-slate-400 tabular-nums">
                    {items.length}
                  </span>
                </button>

                {/* 桶内卡片列表 */}
                {isOpen && (
                  <div className="p-2 space-y-1">
                    {items.map(part => {
                      const resolvedColor = getDefaultColorCode(part.part_id, 71);
                      const isAutoColor = resolvedColor !== 71;
                      return (
                        <button
                          key={part.part_id}
                          onClick={() => previewPart(part.part_id)}
                          title={part.zh_desc || part.name || undefined}
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
                              {part.zh_name || part.name || part.part_id.replace('.dat', '')}
                            </div>
                            <div
                              className="text-[10px] text-slate-400 tracking-wider truncate"
                              title={
                                part.plug_count != null && part.plug_count > 0
                                  ? '走法 A 期 A2：ports = 物理 commit 单元（底层怎么接）；plugs = 视觉/选择聚合层（用户怎么看）。例：2x4 plate 8 port / 2 plug（顶/底各 1 整片 stud）。'
                                  : undefined
                              }
                            >
                              <span className="font-mono text-slate-500">{part.part_id.replace('.dat', '')}</span>
                              <span className="mx-1">·</span>
                              <span className="uppercase">{formatPortPlugLabel(part.port_count, part.plug_count)}</span>
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
                    })}
                  </div>
                )}
              </div>
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

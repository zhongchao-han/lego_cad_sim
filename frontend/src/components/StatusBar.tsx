import React, { useMemo } from 'react';
import { useStore } from '../store';
import { InteractionPhase, ZoneType } from '../types';
import { fitDisplayLabel, fitForSlide } from '../utils/fitMath';
import { analyzeStability } from '../utils/staticsMath';
import { countAssemblyFreePortsCheap } from '../utils/freePorts';
import {
  countAssemblyFreePlugsCheap,
  countAssemblyTotalPlugsCheap,
} from '../utils/freePlugs';

export function StatusBar() {
  const interactionPhase = useStore((state) => state.interactionPhase);
  const selectedPort = useStore((state) => state.selectedPort);
  // 是否有选中零件（IDLE 下决定是否提示"[/] 转 / 方向键平移"已放置零件编辑）。
  const hasSelection = useStore((state) => state.selection.primaryId !== null);
  const slidingTarget = useStore((state) => state.slidingTarget);
  const slideOffset = useStore((state) => state.slideOffset);
  const parts = useStore((state) => state.parts);
  const partCatalog = useStore((state) => state.partCatalog);
  const occupiedPorts = useStore((state) => state.occupiedPorts);
  const mode = useStore((state) => state.mode);
  const activePartsCount = useStore((state) => {
    return Object.values(state.parts).filter(p => p.zone === ZoneType.ACTIVE_ARENA).length;
  });

  // B.3-3：上一次 snap 命中的 port pair 总数（plug-snap = >1）。
  // 用户做完 plug 整片 snap 之后，立刻能在 StatusBar 看到"刚刚一次连了 N 颗"
  // 反馈；常态单点 snap = 1，不显示。abort/deselect 清 0 → 隐藏。
  const lastSnapPairCount = useStore((s) => s.lastSnapPairCount);

  // B.3-extension：pre-commit 预览 — SOURCE_LOCKED + PLUG hover target 时
  // 的预计 pair 数上界。null = 无预测 / 不在 PLUG hover 状态，不显示。
  const predictedSnapPairCount = useStore((s) => s.predictedSnapPairCount);

  // L51：稳定性指示。ASSEMBLY 模式 + 多 part 时显示，unstable 走醒目红字。
  const showReactionForces = useStore((s) => s.showReactionForces);
  const setShowReactionForces = useStore((s) => s.setShowReactionForces);
  const reactionForces = useStore((s) => s.reactionForces);

  // L51b PR-C：扫所有 edge stress，找最严重的 safety_ratio。
  // 三档：< 0.7 不显示（健康）；0.7~1.0 黄色 caution；>= 1.0 红色"yields"。
  const maxStress = useMemo(() => {
    let max = 0;
    let yielded = false;
    for (const r of Object.values(reactionForces)) {
      if (!r.stress) continue;
      if (r.stress.safetyRatio > max) max = r.stress.safetyRatio;
      if (r.stress.yields) yielded = true;
    }
    if (yielded) return { text: '⚠ 已屈服', isYield: true, isWarning: false };
    if (max >= 0.7) return {
      text: `⚠ ${(max * 100).toFixed(0)}% 接近屈服`,
      isYield: false,
      isWarning: true,
    };
    return null;
  }, [reactionForces]);

  const stabilityLabel = useMemo(() => {
    if (mode !== 'ASSEMBLY') return null;
    // L51b PR-A：与 Scene.jsx 同样把 quaternion / comLocal / bbox* 喂给 staticsMath
    const items = Object.values(parts)
      .filter(p => p.zone === ZoneType.ACTIVE_ARENA)
      .map(p => {
        const meta = partCatalog[p.ldrawId];
        return {
          position:   p.position,
          quaternion: p.quaternion,
          mass:       meta?.massKg ?? 0.001,
          comLocal:   meta?.comLocal ?? null,
          bboxSize:   meta?.bboxSize ?? null,
          bboxCenter: meta?.bboxCenter ?? null,
        };
      });
    if (items.length < 2) return null; // 单零件总是稳定，不显示
    const r = analyzeStability(items);
    return r.isStable
      ? { text: '🟢 稳定', isUnstable: false }
      : { text: '⚠ 不稳定', isUnstable: true };
  }, [parts, partCatalog, mode]);

  // 走法 A 期 A1：装配体可用 port 数（estimate cheap：portCount - 已占用）。
  // 完整 port-level 视图见 utils/freePorts.computeFreePorts；StatusBar hook
  // 数量稳定限制无法每 part 拉 sites，走 partCatalog.portCount 估算。
  const totalFreePorts = useMemo(
    () => countAssemblyFreePortsCheap(parts, partCatalog, occupiedPorts, ZoneType.ACTIVE_ARENA),
    [parts, partCatalog, occupiedPorts],
  );

  // 走法 A 期 A2 — 1b：plug 概览（总容量 + 可用估算下界）。
  // 同样走 cheap 路径，跟 totalFreePorts 对称。精确视图应走
  // utils/freePlugs.computeFreePlugs（每 InteractivePart 已持有 plugs）。
  const totalPlugs = useMemo(
    () => countAssemblyTotalPlugsCheap(parts, partCatalog, ZoneType.ACTIVE_ARENA),
    [parts, partCatalog],
  );
  const totalFreePlugs = useMemo(
    () => countAssemblyFreePlugsCheap(parts, partCatalog, occupiedPorts, ZoneType.ACTIVE_ARENA),
    [parts, partCatalog, occupiedPorts],
  );

  // L46：AXIAL_SLIDING 时显示 source / target 端口的 FitType 标签，
  // 让用户知道为什么按 ↑ 慢/快（CLEARANCE 全速 / FRICTION 1/4 速 / 等）。
  const slideFitLabel = useMemo(() => {
    if (interactionPhase !== InteractionPhase.AXIAL_SLIDING) return null;
    if (!selectedPort || !slidingTarget) return null;
    const fit = fitForSlide(selectedPort.portType, slidingTarget.portType);
    return fitDisplayLabel(fit);
  }, [interactionPhase, selectedPort, slidingTarget]);

  // 中文操作提示，按当前阶段告诉用户"现在能做什么"。IDLE 下若已选中零件，
  // 追加"已放置零件编辑"提示（[/] 转 / 方向键平移）。
  const centerHints = useMemo(() => {
    switch (interactionPhase) {
      case InteractionPhase.IDLE:
        return hasSelection
          ? '左键: 选择零件 ┊ Alt+点端口: 连接 ┊ [ / ]: 旋转选中件 90° ┊ 方向键: 平移(Shift 细调) ┊ Del: 删除 ┊ Esc: 取消'
          : '左键: 选择零件 ┊ Alt+点端口: 发起连接 ┊ 拖拽: 旋转视角 ┊ Esc: 取消选择';
      case InteractionPhase.SOURCE_LOCKED:
        return 'Alt+点目标端口: 吸附 ┊ [ / ]: 绕轴旋转 90° ┊ Esc: 取消';
      case InteractionPhase.AXIAL_SLIDING:
        return '↑/↓: 调插入深度 ┊ Shift+↑/↓: ×10 ┊ [ / ]: 转 90° ┊ Enter 或 再点一下: 确认吸附 ┊ Esc: 取消';
      case InteractionPhase.FREE_PLACING:
        return '左键: 放置到地面 ┊ Esc: 取消';
      case InteractionPhase.PREVIEWING:
        return '左键: 放入场景 ┊ Esc: 取消';
      case InteractionPhase.ANIMATING_SNAP:
        return '正在计算运动学…';
      default:
        return '';
    }
  }, [interactionPhase, hasSelection]);

  const phaseLabel = useMemo(() => {
    switch (interactionPhase) {
      case InteractionPhase.IDLE: return '🟢 就绪';
      case InteractionPhase.SOURCE_LOCKED: return '🟡 已锁定源端口';
      case InteractionPhase.AXIAL_SLIDING: return '🔵 调整插入深度';
      case InteractionPhase.FREE_PLACING: return '🟣 自由放置';
      case InteractionPhase.PREVIEWING: return '⚪ 预览中';
      case InteractionPhase.ANIMATING_SNAP: return '🟠 吸附动画中';
      default: return interactionPhase;
    }
  }, [interactionPhase]);

  return (
    <div className="absolute bottom-0 left-0 w-full h-7 bg-slate-900 border-t border-slate-800 flex items-center justify-between px-4 pointer-events-auto z-[60] text-[11px] font-mono select-none">
      <div className="flex items-center gap-4 text-slate-300 w-1/3">
        <span className="font-bold tracking-wider">{phaseLabel}</span>
        {selectedPort && (
          <>
            <div className="w-px h-3 bg-slate-700" />
            <span className="truncate">
              零件: <span className="text-blue-400">{selectedPort.ldrawId}</span> |
              端口: <span className="text-emerald-400">{selectedPort.portType}</span>
            </span>
          </>
        )}
      </div>

      <div className="flex items-center justify-center text-slate-300 w-1/3 truncate">
        {centerHints}
      </div>

      <div className="flex items-center justify-end gap-4 text-slate-300 w-1/3">
        {interactionPhase === InteractionPhase.AXIAL_SLIDING && (
          <span className="text-amber-400">
            深度偏移: {slideOffset.toFixed(1)} LDU
          </span>
        )}
        {slideFitLabel && (
          <span className="text-slate-200 tracking-wide" title="L46 配合反馈">
            配合: {slideFitLabel}
          </span>
        )}
        {stabilityLabel && (
          <span
            className={`tracking-wide font-medium ${
              stabilityLabel.isUnstable ? 'text-red-400' : 'text-slate-300'
            }`}
            title="L51 静态稳定性：COM 投影是否落在接触地面零件的 footprint 凸包内"
          >
            {stabilityLabel.text}
          </span>
        )}
        {/* L51b PR-B：反力可视化 toggle */}
        <button
          type="button"
          onClick={() => setShowReactionForces(!showReactionForces)}
          className={`px-1.5 rounded transition-colors ${
            showReactionForces
              ? 'bg-emerald-700/40 text-emerald-200 hover:bg-emerald-700/60'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="L51b 反力可视化：每条连接 edge 上画一支力箭头；色彩按 von Mises safety_ratio（PR-C）"
        >
          ⇡ 受力
        </button>
        {/* L51b PR-C：屈服 / 接近屈服告警 */}
        {maxStress && (
          <span
            className={`tracking-wide font-medium ${
              maxStress.isYield ? 'text-red-500 animate-pulse' : 'text-amber-400'
            }`}
            title="L51b 真应力近似：σ_vm / ABS_yield (40 MPa)。多 edge 取最严重值"
          >
            {maxStress.text}
          </span>
        )}
        <div className="w-px h-3 bg-slate-700" />
        <span>零件: <span className="text-white font-bold">{activePartsCount}</span></span>
        {activePartsCount > 0 && (
          <span
            data-testid="free-ports-count"
            title="装配体可用接口数（估算）= 各零件 portCount - 已占用 portKey 数。双面 connhole 在 portCount 计 2 但占用通常只占一面，估值稍偏大。"
          >
            空闲: <span className="text-cyan-400 font-bold">{totalFreePorts}</span>
          </span>
        )}
        {/* 走法 A 期 A2 — 1b：plug 概览（plug = 用户视角的整片接口聚合）。
            "Plugs: total / free" — total 来自 partCatalog.plugCount baked，
            free 是下界估算（实际 free plug 数 ≥ 此值）。 */}
        {activePartsCount > 0 && totalPlugs > 0 && (
          <span
            data-testid="free-plugs-count"
            title="装配体 plug 概览：total = ACTIVE_ARENA 各零件 plugCount 求和（plug 是用户视角的整片接口聚合，比如 2x4 plate 顶/底各 1 plug，2780 销头/尾各 1 plug）。free = 估算下界（plugCount - floor(occupied × plugCount / portCount)），实际 free plug 数 ≥ 此值。"
          >
            插口: <span className="text-violet-400 font-bold">{totalPlugs}</span>
            {' / '}
            <span className="text-emerald-400 font-bold">{totalFreePlugs}</span>
          </span>
        )}
        {/* B.3-extension：pre-commit 预览 — PLUG mode hover target 时显
            "Will snap up to N pairs" 上界估计。amber 跟 commit 后的橙
            色 ✓ N pairs 区分（预测 vs 落地）。仅 > 1 时显示。 */}
        {predictedSnapPairCount !== null && predictedSnapPairCount > 1 && (
          <span
            data-testid="predicted-snap-pair-count"
            title="预计 snap 后将闭合的 port pair 数上界 = min(source.plug.port_count, target.plug.port_count)，仅在源 / 目标兼容时显示。上界，不是精确值 — 几何错位时实际 Auto-Latch 可能少于此值，commit 后看 ✓ N pairs 真值。"
            className="text-amber-300 font-bold"
          >
            ≤ {predictedSnapPairCount} 对
          </span>
        )}
        {/* B.3-3：plug-snap 反馈 — 上一次 snap 命中的 port pair 总数。
            只在 > 1 时显示（单点 snap = 1，无新信息；plug 整片 snap 多对）。
            橙色配 ACTIVE_COLOR 让用户感受"刚刚整片落地"。 */}
        {lastSnapPairCount > 1 && (
          <span
            data-testid="last-snap-pair-count"
            title="上一次 snap 命中的 port pair 总数 = 1 个主连接 + 后端 Auto-Latch 自动闭合的额外连接。常态单点 snap = 1 不显示；plug 整片 snap 时多对一起落地。abort/deselect/下一次 snap 会刷新此值。"
            className="text-orange-400 font-bold"
          >
            ✓ {lastSnapPairCount} 对
          </span>
        )}
        <div className="w-px h-3 bg-slate-700" />
        <span>栅格: 1 LDU</span>
      </div>
    </div>
  );
}

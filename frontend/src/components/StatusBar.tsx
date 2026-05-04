import React, { useMemo } from 'react';
import { useStore } from '../store';
import { InteractionPhase, ZoneType } from '../types';
import { fitDisplayLabel, fitForSlide } from '../utils/fitMath';
import { analyzeStability } from '../utils/staticsMath';

export function StatusBar() {
  const interactionPhase = useStore((state) => state.interactionPhase);
  const selectedPort = useStore((state) => state.selectedPort);
  const slidingTarget = useStore((state) => state.slidingTarget);
  const slideOffset = useStore((state) => state.slideOffset);
  const parts = useStore((state) => state.parts);
  const partCatalog = useStore((state) => state.partCatalog);
  const mode = useStore((state) => state.mode);
  const activePartsCount = useStore((state) => {
    return Object.values(state.parts).filter(p => p.zone === ZoneType.ACTIVE_ARENA).length;
  });

  // L51：稳定性指示。ASSEMBLY 模式 + 多 part 时显示，unstable 走醒目红字。
  const stabilityLabel = useMemo(() => {
    if (mode !== 'ASSEMBLY') return null;
    const points = Object.values(parts)
      .filter(p => p.zone === ZoneType.ACTIVE_ARENA)
      .map(p => ({
        position: p.position,
        mass: partCatalog[p.ldrawId]?.massKg ?? 0.001,
      }));
    if (points.length < 2) return null; // 单零件总是稳定，不显示
    const r = analyzeStability(points);
    return r.isStable
      ? { text: '🟢 Stable', isUnstable: false }
      : { text: '⚠ Unstable', isUnstable: true };
  }, [parts, partCatalog, mode]);

  // L46：AXIAL_SLIDING 时显示 source / target 端口的 FitType 标签，
  // 让用户知道为什么按 ↑ 慢/快（CLEARANCE 全速 / FRICTION 1/4 速 / 等）。
  const slideFitLabel = useMemo(() => {
    if (interactionPhase !== InteractionPhase.AXIAL_SLIDING) return null;
    if (!selectedPort || !slidingTarget) return null;
    const fit = fitForSlide(selectedPort.portType, slidingTarget.portType);
    return fitDisplayLabel(fit);
  }, [interactionPhase, selectedPort, slidingTarget]);

  const centerHints = useMemo(() => {
    switch (interactionPhase) {
      case InteractionPhase.IDLE:
        return '[Left Click: Select/Connect] [Drag: Rotate View] [Del: Delete] [Esc: Deselect All]';
      case InteractionPhase.SOURCE_LOCKED:
        return '[Left Click: Select Target Port] [Esc: Cancel Selection]';
      case InteractionPhase.AXIAL_SLIDING:
        return '[↑/↓: Adjust Depth] [Shift+↑/↓: x10] [[/]: Rotate 90°] [Enter: Commit] [Esc: Abort]';
      case InteractionPhase.FREE_PLACING:
        return '[Left Click: Place] [Esc: Abort]';
      case InteractionPhase.PREVIEWING:
        return '[Left Click: Place in Scene] [Esc: Cancel]';
      case InteractionPhase.ANIMATING_SNAP:
        return 'Calculating kinematics...';
      default:
        return '';
    }
  }, [interactionPhase]);

  const phaseLabel = useMemo(() => {
    switch (interactionPhase) {
      case InteractionPhase.IDLE: return '🟢 READY';
      case InteractionPhase.SOURCE_LOCKED: return '🟡 SOURCE LOCKED';
      case InteractionPhase.AXIAL_SLIDING: return '🔵 AXIAL SLIDING';
      case InteractionPhase.FREE_PLACING: return '🟣 FREE PLACING';
      case InteractionPhase.PREVIEWING: return '⚪ PREVIEWING';
      case InteractionPhase.ANIMATING_SNAP: return '🟠 ANIMATING';
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
              Part: <span className="text-blue-400">{selectedPort.ldrawId}</span> | 
              Port: <span className="text-emerald-400">{selectedPort.portType}</span>
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
            Offset: {slideOffset.toFixed(1)} LDU
          </span>
        )}
        {slideFitLabel && (
          <span className="text-slate-200 tracking-wide" title="L46 fit feedback">
            Fit: {slideFitLabel}
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
        <div className="w-px h-3 bg-slate-700" />
        <span>Parts: <span className="text-white font-bold">{activePartsCount}</span></span>
        <div className="w-px h-3 bg-slate-700" />
        <span>Grid: 1 LDU</span>
      </div>
    </div>
  );
}

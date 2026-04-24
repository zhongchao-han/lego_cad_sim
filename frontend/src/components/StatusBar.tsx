import React, { useMemo } from 'react';
import { useStore } from '../store';
import { InteractionPhase, ZoneType } from '../types';

export function StatusBar() {
  const interactionPhase = useStore((state) => state.interactionPhase);
  const selectedPort = useStore((state) => state.selectedPort);
  const slideOffset = useStore((state) => state.slideOffset);
  const activePartsCount = useStore((state) => {
    return Object.values(state.parts).filter(p => p.zone === ZoneType.ACTIVE_ARENA).length;
  });

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
        <div className="w-px h-3 bg-slate-700" />
        <span>Parts: <span className="text-white font-bold">{activePartsCount}</span></span>
        <div className="w-px h-3 bg-slate-700" />
        <span>Grid: 1 LDU</span>
      </div>
    </div>
  );
}

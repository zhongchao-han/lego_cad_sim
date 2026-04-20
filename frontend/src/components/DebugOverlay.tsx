import React from 'react';
import { useStore } from '../store';
import { clearAllPartCache } from '../useLDrawPart';
import { Bug, Trash2, Cpu } from 'lucide-react';

export const DebugOverlay: React.FC = () => {
    const { debugMode, setDebugMode, addLog } = useStore();

    if (!debugMode) {
        return (
            <button 
                onClick={() => setDebugMode(true)}
                className="fixed bottom-4 left-4 bg-slate-900/50 backdrop-blur-md p-3 rounded-full shadow-lg hover:bg-slate-800 transition-colors z-50 text-slate-400 hover:text-white"
                title="Enable Debug Mode"
            >
                <Bug size={18} />
            </button>
        );
    }

    const handleClearColorCache = () => {
        clearAllPartCache();
        addLog("Cleared LDraw part color cache.", "ACTION");
        alert("LDraw 零件与颜色缓存已清除。");
    };

    return (
        <div className="fixed bottom-4 left-4 z-[1000] bg-slate-900/90 backdrop-blur-xl border border-rose-500/30 p-4 rounded-xl shadow-2xl w-64 text-white font-mono text-xs slide-in-from-bottom-5 animate-in">
            <div className="flex items-center justify-between mb-4 border-b border-white/10 pb-2">
                <div className="flex items-center gap-2 text-rose-400 font-bold">
                    <Bug size={16} />
                    <span>DEBUG MODE</span>
                </div>
                <button 
                    onClick={() => setDebugMode(false)}
                    className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-[10px]"
                >
                    EXIT
                </button>
            </div>
            
            <div className="space-y-3">
                <div className="flex flex-col gap-2">
                    <span className="text-slate-400">Cache Controls</span>
                    <button 
                        onClick={handleClearColorCache}
                        className="flex items-center gap-2 w-full p-2 bg-rose-500/20 hover:bg-rose-500/40 border border-rose-500/50 rounded transition-colors text-left"
                    >
                        <Trash2 size={14} className="text-rose-400" />
                        <span>Clear Color/Part Cache</span>
                    </button>
                </div>
                
                <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-white/10">
                    <span className="text-slate-400">Overlays Active</span>
                    <div className="flex items-center gap-2 text-emerald-400">
                        <Cpu size={14} />
                        <span>Perf Monitor (Top-Left)</span>
                    </div>
                    <div className="flex items-center gap-2 text-emerald-400">
                        <Bug size={14} />
                        <span>Action Logs (Bottom-Right)</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

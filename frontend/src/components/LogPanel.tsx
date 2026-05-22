import React, { useRef, useEffect } from 'react';
import { useStore } from '../store';
import { Terminal, Copy, Trash2, X, ChevronDown, ChevronUp, AlertCircle, Activity } from 'lucide-react';

export const LogPanel: React.FC = () => {
    const { logs, showLogPanel, toggleLogPanel, clearLogs, debugMode } = useStore();
    const scrollRef = useRef<HTMLDivElement>(null);

    // 自动滚动到底部
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs, showLogPanel, debugMode]);

    const copyToClipboard = () => {
        const text = logs.map(l => `[${new Date(l.timestamp).toLocaleTimeString()}] ${l.type}: ${l.message}${l.count && l.count >= 2 ? ` (×${l.count})` : ''}`).join('\n');
        navigator.clipboard.writeText(text);
        alert('Logs copied to clipboard!');
    };

    if (!showLogPanel && !debugMode) {
        return (
            <button 
                onClick={() => toggleLogPanel(true)}
                className="fixed bottom-4 right-4 bg-gray-900/80 backdrop-blur-md border border-white/10 p-3 rounded-full shadow-2xl hover:bg-black transition-all flex items-center space-x-2 text-white group"
                title="Open Action Log"
            >
                <Terminal size={18} className="text-emerald-400 group-hover:scale-110 transition-transform" />
                <span className="text-xs font-semibold px-1">LOGS</span>
                {logs.length > 0 && (
                    <span className="absolute -top-1 -right-1 bg-emerald-500 text-[10px] px-1.5 py-0.5 rounded-full animate-pulse">
                        {logs.length}
                    </span>
                )}
            </button>
        );
    }

    return (
        <div className="fixed bottom-4 right-4 w-[450px] h-[350px] bg-slate-900/90 backdrop-blur-xl border border-white/20 rounded-xl shadow-2xl flex flex-col overflow-hidden z-[1000] animate-in slide-in-from-bottom-5">
            {/* Header */}
            <div className="bg-white/5 border-b border-white/10 p-3 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                    <Terminal size={16} className="text-emerald-400" />
                    <span className="text-sm font-bold text-white tracking-widest uppercase">System Activity Log</span>
                </div>
                <div className="flex items-center space-x-1">
                    <button onClick={copyToClipboard} className="p-1.5 hover:bg-white/10 rounded-md text-gray-400 hover:text-white transition-colors" title="Copy All">
                        <Copy size={16} />
                    </button>
                    <button onClick={clearLogs} className="p-1.5 hover:bg-white/10 rounded-md text-gray-400 hover:text-red-400 transition-colors" title="Clear">
                        <Trash2 size={16} />
                    </button>
                    <button onClick={() => toggleLogPanel(false)} className="p-1.5 hover:bg-white/10 rounded-md text-gray-400 hover:text-white transition-colors">
                        <X size={16} />
                    </button>
                </div>
            </div>

            {/* Content */}
            <div 
                ref={scrollRef}
                className="flex-1 overflow-y-auto p-4 font-mono text-[11px] space-y-2 scrollbar-thin scrollbar-thumb-white/10"
            >
                {logs.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-500 space-y-2 italic">
                        <Activity size={24} className="opacity-20" />
                        <p>Waiting for user activity...</p>
                    </div>
                ) : (
                    logs.map((log, i) => (
                        <div key={i} className="flex items-start space-x-3 group animate-in fade-in slide-in-from-left-2 grow">
                            <span className="text-gray-600 shrink-0 select-none">
                                {new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}
                            </span>
                            <span className={`
                                shrink-0 font-bold px-1 rounded-[2px] select-none
                                ${log.type === 'ACTION' ? 'text-blue-400 bg-blue-500/10' : ''}
                                ${log.type === 'PHYSICS' ? 'text-purple-400 bg-purple-500/10' : ''}
                                ${log.type === 'ERROR' ? 'text-red-400 bg-red-500/10' : ''}
                                ${log.type === 'INFO' ? 'text-gray-400 bg-white/5' : ''}
                            `}>
                                {log.type}
                            </span>
                            <div className="flex flex-col">
                                <span className={`
                                    leading-relaxed
                                    ${log.type === 'ERROR' ? 'text-red-300' : 'text-slate-100'}
                                    ${log.type === 'PHYSICS' ? 'text-purple-200' : ''}
                                `}>
                                    {log.message}
                                    {log.count && log.count >= 2 && (
                                        <span className="ml-1 px-1 rounded bg-slate-600 text-slate-200 text-[10px] font-mono">
                                            ×{log.count}
                                        </span>
                                    )}
                                </span>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Footer Status */}
            <div className="p-2 bg-black/40 border-t border-white/5 text-[10px] text-gray-500 flex justify-between items-center px-4">
                <span>TOTAL_EVENTS: {logs.length}</span>
                <span className="flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                    <span className="tracking-tighter">LISTENING_FOR_EVENTS</span>
                </span>
            </div>
        </div>
    );
};

import { useEffect, Suspense, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from './store';
import Scene from './Scene';
import { VerificationWorkbench } from './VerificationWorkbench.tsx';

import { PartLibraryPanel } from './components/PartLibraryPanel';
import { StagingTrayPanel } from './components/StagingTrayPanel';
import { PartPreviewOverlay } from './components/PartPreviewOverlay';
import { LogPanel } from './components/LogPanel';

function UIOverlay() {
  const mode = useStore((state) => state.mode);
  const view = useStore((state) => state.view);
  const setView = useStore((state) => state.setView);
  const toggleMode = useStore((state) => state.toggleMode);
  const wsConnected = useStore((state) => state.wsConnected);
  const addLog = useStore((state) => state.addLog);

  const handleToggleMode = async () => {
      addLog(`User requested mode toggle to ${mode === 'ASSEMBLY' ? 'SIMULATION' : 'ASSEMBLY'}`, 'ACTION');
      await toggleMode();
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-50 flex flex-col">
      {/* 顶部工具栏容器 - 负责自适应避让左侧边栏 */}
      <div className="flex justify-between items-start p-6 w-full">
        {/* 左侧状态组 - 增加一个空的占位 div 对应侧边栏宽度，实现优雅偏移 */}
        <div className="flex gap-4">
          <div className="w-72 shrink-0" /> {/* 侧边栏占位符 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 bg-white/80 backdrop-blur-md px-4 py-2 rounded-2xl shadow-xl border border-white/20 pointer-events-auto">
              <div className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
                <span className="text-xs font-bold tracking-widest text-slate-800 uppercase">
                  {wsConnected ? 'System Online' : 'System Offline (Reconnect...)'}
                </span>
              </div>
              <div className="w-px h-4 bg-slate-200" />
              <div className="flex bg-slate-100/50 p-1 rounded-xl">
                <button 
                  onClick={() => setView('ASSEMBLY')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${view === 'ASSEMBLY' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  ASSEMBLY
                </button>
                <button 
                  onClick={() => setView('LIBRARY_VERIFY')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${view === 'LIBRARY_VERIFY' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  LIBRARY
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧操作组 */}
        <div className="flex flex-col items-end gap-3 pointer-events-auto">
          <button
            onClick={handleToggleMode}
            className={`px-8 py-3 rounded-2xl font-black text-sm tracking-widest shadow-2xl transition-all active:scale-95 border ${
              mode === 'ASSEMBLY' 
                ? 'bg-slate-900 text-white border-slate-700 hover:bg-black' 
                : 'bg-emerald-500 text-white border-emerald-400 hover:bg-emerald-600'
            }`}
          >
            {mode === 'ASSEMBLY' ? 'GO SIMULATION →' : '← BACK TO DESIGN'}
          </button>
          
          <div className="bg-white/90 backdrop-blur-xl p-5 rounded-3xl shadow-2xl border border-white/40 w-72">
            <h3 className="text-[10px] font-black tracking-[0.2em] text-slate-400 mb-4 uppercase">Render Tuning</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between group">
                <span className="text-xs font-bold text-slate-600">SSAO Opt.</span>
                <input type="checkbox" className="w-4 h-4 rounded-full accent-blue-500" defaultChecked />
              </div>
              <div className="flex items-center justify-between group">
                <span className="text-xs font-bold text-slate-600">Trace Shadows</span>
                <input type="checkbox" className="w-4 h-4 rounded-full accent-blue-500" defaultChecked />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 侧边栏与主工作区层叠 */}
      {view === 'ASSEMBLY' && (
        <div className="absolute inset-y-0 left-0 flex pointer-events-none">
          <div className="pointer-events-auto flex flex-col w-72 shadow-2xl bg-white border-r border-slate-200">
            <div className="flex-1 min-h-0 border-b border-slate-100 overflow-hidden">
               <PartLibraryPanel />
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
               <StagingTrayPanel />
            </div>
          </div>
          <PartPreviewOverlay />
        </div>
      )}
    </div>
  );
}

function App() {
  const view = useStore((state) => state.view);
  const setWsConnected = useStore((state) => state.setWsConnected);
  const batchUpdatePartStates = useStore((state) => state.batchUpdatePartStates);

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let isMounted = true;
    let rafId = null;

    const connect = () => {
      if (!isMounted) return;
      
      ws = new WebSocket('ws://localhost:8000/ws/physics_stream');
      
      ws.onopen = () => {
        if (!isMounted) return;
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const data = JSON.parse(event.data);
          // 后端发送的是 {mode, state} 结构
          if (data.state) {
            batchUpdatePartStates(data.state);
          }
        } catch (e) {
          console.error("WS Parse Error:", e);
        }
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            ws.close();
        }
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      clearTimeout(reconnectTimer);
      if (ws) {
          ws.onclose = null;
          ws.close();
      }
    };
  }, [setWsConnected, batchUpdatePartStates]);

  return (
    <div className="w-screen h-screen relative bg-slate-50 overflow-hidden">
      <UIOverlay />

      {view === 'ASSEMBLY' ? (
        <div className="w-full h-full">
          <Canvas
            camera={{ position: [0.05, 0.08, 0.12], fov: 45, near: 0.001, far: 10 }}
            shadows
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1 }}
            className="w-full h-full"
          >
            <Suspense fallback={
              <Html center>
                <div className="flex flex-col items-center gap-3">
                  <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm text-gray-500 font-medium">Loading models…</span>
                </div>
              </Html>
            }>
              <Scene />
            </Suspense>
          </Canvas>
        </div>
      ) : (
        <div className="w-full h-full overflow-hidden">
          <VerificationWorkbench />
        </div>
      )}
      
      <LogPanel />
    </div>
  );
}

export default App;

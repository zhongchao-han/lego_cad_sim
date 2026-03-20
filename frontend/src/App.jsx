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

function UIOverlay() {
  // ... (existing constants)
  const mode = useStore((state) => state.mode);
  const view = useStore((state) => state.view);
  const setView = useStore((state) => state.setView);
  const toggleMode = useStore((state) => state.toggleMode);
  const wsConnected = useStore((state) => state.wsConnected);
  
  const showPortGizmos = useStore((state) => state.showPortGizmos);
  const setShowPortGizmos = useStore((state) => state.setShowPortGizmos);
  const enableFocusAnimation = useStore((state) => state.enableFocusAnimation);
  const setEnableFocusAnimation = useStore((state) => state.setEnableFocusAnimation);
  const enableSSAO = useStore((state) => state.enableSSAO);
  const setEnableSSAO = useStore((state) => state.setEnableSSAO);
  const enableContactShadows = useStore((state) => state.enableContactShadows);
  const setEnableContactShadows = useStore((state) => state.setEnableContactShadows);
  const debugMode = useStore((state) => state.debugMode);
  const setDebugMode = useStore((state) => state.setDebugMode);
  const interactionPhase = useStore((state) => state.interactionPhase);
  const selectedPort = useStore((state) => state.selectedPort);

  return (
    <div className="absolute top-0 left-0 w-full h-full p-4 pointer-events-none z-[60]">
      {/* 侧边物料库 */}
      {view === 'ASSEMBLY' && (
        <div className="absolute top-0 left-0 h-full">
           <PartLibraryPanel />
        </div>
      )}

      {/* 顶部状态与模式切换 (左上角偏移，避免被物料库遮挡) */}
      <div className={`flex flex-col gap-2 pointer-events-auto bg-white/50 backdrop-blur-sm p-4 rounded-lg border border-white/20 shadow-sm absolute top-4 ${view === 'ASSEMBLY' ? 'left-[300px]' : 'left-4'} transition-all`}>
        <h1 className="text-xl font-black text-slate-800 tracking-tight flex items-center gap-2">
          LEGO CAD SIM
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
        </h1>
        <div className={`px-2 py-0.5 rounded text-[10px] font-bold inline-block w-max ${wsConnected ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
          {wsConnected ? 'ENGINE CONNECTED' : 'ENGINE OFFLINE'}
        </div>

        <div className="flex bg-slate-200/50 p-1 rounded-md mt-1 border">
          <button 
            onClick={() => setView('ASSEMBLY')}
            className={`px-3 py-1 rounded text-[10px] font-black transition-all ${view === 'ASSEMBLY' ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
          >
            ASSEMBLY
          </button>
          <button 
            onClick={() => setView('VERIFY')}
            className={`px-3 py-1 rounded text-[10px] font-black transition-all ${view === 'VERIFY' ? 'bg-white shadow text-purple-600' : 'text-gray-500 hover:text-gray-700'}`}
          >
            VERIFY
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 items-end pointer-events-auto absolute top-4 right-4">
        {view === 'ASSEMBLY' && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleMode();
              }}
              className={`flex items-center px-6 py-3 rounded-lg font-black shadow-lg transition-all border-b-4 active:border-b-0 active:translate-y-1 ${mode === 'ASSEMBLY'
                ? 'bg-blue-600 hover:bg-blue-700 text-white border-blue-800'
                : 'bg-amber-500 hover:bg-amber-600 text-white border-amber-700 animate-pulse'
                }`}
            >
              {mode === 'ASSEMBLY' ? 'START SIMULATION' : 'STOP SIMULATION'}
            </button>

            <div className="bg-white/85 backdrop-blur-sm rounded-xl shadow-xl px-4 py-3 text-[10px] space-y-2 border border-slate-200 w-48 font-semibold text-slate-600">
              <div className="text-slate-400 font-bold mb-2 uppercase tracking-widest text-[9px]">Render Tuning</div>
              {[
                { label: 'Port Gizmos', checked: showPortGizmos, set: setShowPortGizmos },
                { label: 'Focus Animation', checked: enableFocusAnimation, set: setEnableFocusAnimation },
                { label: 'SSAO', checked: enableSSAO, set: setEnableSSAO },
                { label: 'Contact Shadows', checked: enableContactShadows, set: setEnableContactShadows },
                { label: 'Debug Axes', checked: debugMode, set: setDebugMode },
              ].map(({ label, checked, set }) => (
                <label key={label} className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded transition-colors">
                  <span>{label}</span>
                  <input type="checkbox" className="accent-blue-600 h-3 w-3" checked={checked} onChange={(e) => set(e.target.checked)} />
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 暂存区仓库 (右边栏) */}
      {view === 'ASSEMBLY' && (
        <div className="absolute top-0 right-0 h-full">
           <StagingTrayPanel />
        </div>
      )}
      <PartPreviewOverlay />

      {/* 底部引导栏 (FSM 驱动) */}
      {view === 'ASSEMBLY' && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur text-white px-6 py-2.5 rounded-full shadow-2xl border border-white/20 pointer-events-none text-xs font-bold flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
          {interactionPhase === 'IDLE' && "Click a part in library or scene port to start."}
          {interactionPhase === 'PICKING_FROM_LIBRARY' && "PREVIEW: Rotate part and click a source port."}
          {interactionPhase === 'SOURCE_LOCKED' && `LOCKED: ${selectedPort?.partId}. Now click a target port in scene.`}
          {interactionPhase === 'ANIMATING_SNAP' && "Sensing geometry... Snap in progress."}
        </div>
      )}
    </div>
  );
}

function App() {
  const setWsConnected = useStore((state) => state.setWsConnected);
  const batchUpdatePartStates = useStore((state) => state.batchUpdatePartStates);
  const view = useStore((state) => state.view);

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let isMounted = true;

    let pendingUpdates = {};
    let rafId = null;

    const flushUpdates = () => {
      rafId = null;
      if (Object.keys(pendingUpdates).length > 0) {
        batchUpdatePartStates(pendingUpdates);
        pendingUpdates = {};
      }
    };

    const connect = () => {
      if (!isMounted) return;
        
      const wsUrl = import.meta.env.VITE_WS_URL || 'ws://127.0.0.1:8000/ws/physics_stream';
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!isMounted) {
            ws.close();
            return;
        }
        console.log('WebSocket connected to Engine.');
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          if (!event.data) return;
          const payload = JSON.parse(event.data);

          if (payload && payload.mode === 'SIMULATION' && payload.state) {
            Object.assign(pendingUpdates, payload.state);
            if (rafId === null) {
              rafId = requestAnimationFrame(flushUpdates);
            }
          }
        } catch (err) {
          console.error('Frame Parse Error:', err);
        }
      };

      ws.onclose = () => {
        if (!isMounted) return;
        console.warn('WebSocket closed, scheduling reconnect...');
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        console.warn("WS Engine: transient connection error (will auto-reconnect)");
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
          {/* 3D 渲染区域 */}
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
    </div>
  );
}

export default App;

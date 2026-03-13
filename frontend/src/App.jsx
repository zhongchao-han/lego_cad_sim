import { useEffect, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from './store';
import Scene from './Scene';
function UIOverlay() {
  const mode = useStore((state) => state.mode);
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

  return (
    <div className="absolute top-0 left-0 w-full h-full p-4 flex justify-between items-start pointer-events-none z-50">
      <div className="flex flex-col gap-2 pointer-events-auto bg-white/50 backdrop-blur-sm p-2 rounded-lg border border-white/20 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-800 drop-shadow-md">
          LEGO Editor
        </h1>
        <div className={`px-2 py-1 rounded-full text-xs font-bold inline-block w-max ${wsConnected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
          {wsConnected ? 'Engine Connected' : 'Engine Disconnected'}
        </div>
      </div>

      <div className="flex flex-col gap-3 items-end pointer-events-auto z-50">
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleMode();
          }}
          className={`flex items-center px-6 py-3 rounded-lg font-bold shadow-lg transition-all ${mode === 'ASSEMBLY'
            ? 'bg-blue-600 hover:bg-blue-700 text-white'
            : 'bg-amber-500 hover:bg-amber-600 text-white animate-pulse'
            }`}
        >
          {mode === 'ASSEMBLY' ? (
            <>START SIMULATION</>
          ) : (
            <>STOP SIMULATION</>
          )}
        </button>

        {/* 调试与渲染控制面板 */}
        <div className="bg-white/85 backdrop-blur-sm rounded-lg shadow px-4 py-3 text-xs space-y-2 border">
          <div className="font-semibold text-gray-700 mb-1">
            Render Controls
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-blue-600"
              checked={showPortGizmos}
              onChange={(e) => setShowPortGizmos(e.target.checked)}
            />
            <span>Show port gizmos</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-blue-600"
              checked={enableFocusAnimation}
              onChange={(e) => setEnableFocusAnimation(e.target.checked)}
            />
            <span>Enable focus animation</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-blue-600"
              checked={enableSSAO}
              onChange={(e) => setEnableSSAO(e.target.checked)}
            />
            <span>SSAO (ambient occlusion)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-blue-600"
              checked={enableContactShadows}
              onChange={(e) => setEnableContactShadows(e.target.checked)}
            />
            <span>Contact shadows</span>
          </label>
        </div>
      </div>

      {/* 底部引导栏 */}
      {mode === 'ASSEMBLY' && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white/80 backdrop-blur px-6 py-2 rounded-full shadow border pointer-events-none">
          Click two ports to snap them together.
        </div>
      )}
    </div>
  );
}

function App() {
  const setWsConnected = useStore((state) => state.setWsConnected);
  const batchUpdatePartStates = useStore((state) => state.batchUpdatePartStates);

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
  );
}

export default App;

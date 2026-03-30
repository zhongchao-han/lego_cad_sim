import { useEffect, Suspense } from 'react';
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
import { ThumbnailGenerator } from './ThumbnailGenerator.tsx';

// ---------------------------------------------------------------------------
// 组装模式专用 UI 蒙层
// ---------------------------------------------------------------------------
function AssemblyUI() {
  const mode = useStore((state) => state.mode);
  const setView = useStore((state) => state.setView);
  const toggleMode = useStore((state) => state.toggleMode);
  const wsConnected = useStore((state) => state.wsConnected);

  return (
    <div className="absolute inset-0 pointer-events-none z-50 flex flex-col">
      <div className="flex justify-between items-start p-6 w-full">
        <div className="flex gap-4">
          <div className="w-72 shrink-0" /> {/* 避让侧边栏 */}
          <div className="flex items-center gap-3 bg-white/80 backdrop-blur-md px-4 py-2 rounded-2xl shadow-xl border border-white/20 pointer-events-auto">
            <div className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            <button onClick={() => setView('ASSEMBLY')} className="text-xs font-bold text-blue-600">ASSEMBLY</button>
            <div className="w-px h-3 bg-slate-200" />
            <button onClick={() => setView('LIBRARY_VERIFY')} className="text-xs font-bold text-slate-400 hover:text-slate-600 focus:outline-none">LIBRARY</button>
          </div>
        </div>

        <div className="flex flex-col items-end gap-3 pointer-events-auto">
          <button onClick={() => toggleMode()} className="px-8 py-3 rounded-2xl font-black text-sm bg-slate-900 text-white shadow-2xl">
            {mode === 'ASSEMBLY' ? 'GO SIMULATION →' : '← BACK TO DESIGN'}
          </button>
          <div className="bg-white/90 backdrop-blur-xl p-5 rounded-3xl shadow-2xl border border-white/40 w-72">
            <h3 className="text-[10px] font-black tracking-widest text-slate-400 mb-2 uppercase">Render Tuning</h3>
            <div className="flex items-center justify-between text-xs font-bold text-slate-600">
               <span>SSAO / Shadows</span>
               <input type="checkbox" defaultChecked className="accent-blue-500" />
            </div>
          </div>
        </div>
      </div>

      <div className="absolute inset-y-0 left-0 flex pointer-events-none">
        <div className="pointer-events-auto flex flex-col w-72 shadow-2xl bg-white border-r border-slate-200 h-full overflow-hidden">
          <div className="flex-1 min-h-0 border-b border-slate-100 overflow-y-auto">
             <PartLibraryPanel />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
             <StagingTrayPanel />
          </div>
        </div>
      </div>

      {/* 零件预览弹窗：挂载在根级确保 absolute inset-0 覆盖全视口 */}
      <PartPreviewOverlay />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 库校验模式专用顶部导航
// ---------------------------------------------------------------------------
function LibraryNav() {
    const setView = useStore((state) => state.setView);
    return (
        <div className="absolute top-6 left-6 z-[60] flex items-center gap-3 bg-white/90 backdrop-blur-md px-4 py-2 rounded-2xl shadow-xl border border-white/20 pointer-events-auto">
            <button onClick={() => setView('ASSEMBLY')} className="text-xs font-bold text-slate-400 hover:text-slate-600">ASSEMBLY</button>
            <div className="w-px h-3 bg-slate-200" />
            <button onClick={() => setView('LIBRARY_VERIFY')} className="text-xs font-bold text-blue-600">LIBRARY VERIFY</button>
        </div>
    );
}

function App() {
  const view = useStore((state) => state.view);
  const setWsConnected = useStore((state) => state.setWsConnected);
  const batchUpdatePartStates = useStore((state) => state.batchUpdatePartStates);
  const abortCurrentInteraction = useStore((state) => state.abortCurrentInteraction);
  const interactionPhase = useStore((state) => state.interactionPhase);

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let isMounted = true;
    const connect = () => {
      if (!isMounted) return;
      ws = new WebSocket('ws://localhost:8000/ws/physics_stream');
      ws.onopen = () => { if (isMounted) setWsConnected(true); };
      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const data = JSON.parse(event.data);
          if (data.state) batchUpdatePartStates(data.state);
        } catch {
          // ignore parsing error
        }
      };
      ws.onclose = () => { if (isMounted) { setWsConnected(false); reconnectTimer = setTimeout(connect, 2000); } };
    };
    connect();
    return () => { isMounted = false; clearTimeout(reconnectTimer); if (ws) ws.close(); };
  }, [setWsConnected, batchUpdatePartStates]);


  // 键盘全局监听：ESC 取消选中
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        abortCurrentInteraction();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [abortCurrentInteraction]);

  // 神器级别无侵入拦截：隔离离线 GPU 提图工具引擎，严禁污染主应用状态树
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }

  return (
    <div className="w-screen h-screen relative bg-slate-50 overflow-hidden">
      {/* 宏观策略：分视图渲染 UI，互不干扰 */}
      {view === 'ASSEMBLY' ? <AssemblyUI /> : <LibraryNav />}

      {view === 'ASSEMBLY' ? (
        <div className="w-full h-full">
          <Canvas
            camera={{ position: [0.3, 0.4, 0.5], fov: 45, near: 0.001, far: 50 }}
            shadows
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
            className="w-full h-full"
            onPointerMissed={() => {
                // 如果当前正在锁定源端口，点击空白处则释放
                if (interactionPhase !== 'IDLE') {
                    abortCurrentInteraction();
                }
            }}
          >
            <Suspense fallback={<Html center><span>Loading…</span></Html>}>
              <Scene />
            </Suspense>
          </Canvas>
        </div>
      ) : (
        <div className="w-full h-full z-10">
          <VerificationWorkbench />
        </div>
      )}
      
      <LogPanel />
    </div>
  );
}

export default App;

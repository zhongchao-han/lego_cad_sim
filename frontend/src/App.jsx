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
import { PartSearchDialog } from './components/PartSearchDialog';
import { RenderErrorBoundary } from './components/RenderErrorBoundary';
import { WebGLRecoveryWatcher } from './components/WebGLRecoveryWatcher';
import { useKeyboardDispatcher } from './hooks/useKeyboardDispatcher';
import { isTurntableAssemblyTop } from './utils/turntableAssembly';
import { getDefaultColorCode } from './utils/partColorDefaults';
import { DebugOverlay } from './components/DebugOverlay';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { MarqueeBox } from './components/MarqueeBox';

// ---------------------------------------------------------------------------
// 组装模式专用 UI 蒙层
// ---------------------------------------------------------------------------
function AssemblyUI() {
  const mode = useStore((state) => state.mode);
  const setView = useStore((state) => state.setView);
  const toggleMode = useStore((state) => state.toggleMode);
  const wsConnected = useStore((state) => state.wsConnected);
  // issue #63 fix follow-up：UI 订阅 store 字段反馈 toggleMode 失败 / 进行中。
  const modeToggleError = useStore((state) => state.modeToggleError);
  const modeToggling = useStore((state) => state.modeToggling);

  return (
    <div className="absolute inset-0 pointer-events-none z-50 flex flex-col">
      <div className="flex justify-between items-start p-6 w-full">
        <div className="flex gap-4">
          <div className="w-72 shrink-0" /> {/* 避让侧边栏 */}
          <div className="flex items-center gap-3 bg-white/80 backdrop-blur-md px-4 py-2 rounded-2xl shadow-xl border border-white/20 pointer-events-auto">
            <div className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            <button onClick={() => setView('EDITOR')} className="text-xs font-bold text-blue-600">ASSEMBLY</button>
            <div className="w-px h-3 bg-slate-200" />
            <button onClick={() => setView('WORKBENCH')} className="text-xs font-bold text-slate-400 hover:text-slate-600 focus:outline-none">LIBRARY</button>
          </div>
        </div>

        {/* 顶部固定工具栏：常驻功能 + 快捷键 + 选中件操作（不可用时灰显） */}
        <Toolbar />

        {/* 模式切换按钮 + 失败 inline 错误提示。modeToggling 期间 disabled 防双击；
            modeToggleError 非 null 时按钮下方显示红色 banner（持续到下次切换）。 */}
        <div className="flex flex-col items-end gap-2 pointer-events-auto">
          <button
            onClick={() => toggleMode()}
            disabled={modeToggling}
            data-testid="mode-toggle-button"
            className={`px-8 py-3 rounded-2xl font-black text-sm shadow-2xl transition-all ${
              modeToggling
                ? 'bg-slate-400 text-white cursor-not-allowed opacity-70'
                : 'bg-slate-900 text-white hover:bg-slate-800'
            }`}
          >
            {modeToggling
              ? '切换中…'
              : mode === 'ASSEMBLY' ? 'GO SIMULATION →' : '← BACK TO DESIGN'}
          </button>
          {modeToggleError && (
            <div
              data-testid="mode-toggle-error"
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-100 border border-red-300 text-red-800 max-w-xs shadow-md"
              title={modeToggleError}
            >
              切换失败：<span className="truncate inline-block max-w-[14rem] align-bottom">{modeToggleError}</span>
            </div>
          )}
        </div>
      </div>

      <div className="absolute top-0 bottom-7 left-0 flex pointer-events-none z-10">
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

      {/* 框选矩形：Canvas 外 HTML overlay（控制器在 Scene 内的 MarqueeSelectionOverlay） */}
      <MarqueeBox />

      {/* 全局底部状态栏 */}
      <StatusBar />
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
            <button onClick={() => setView('EDITOR')} className="text-xs font-bold text-slate-400 hover:text-slate-600">ASSEMBLY</button>
            <div className="w-px h-3 bg-slate-200" />
            <button onClick={() => setView('WORKBENCH')} className="text-xs font-bold text-blue-600">LIBRARY VERIFY</button>
        </div>
    );
}

function App() {
  // /generator 路由由 main.jsx 在挂载前分流到 ThumbnailGenerator。
  const view = useStore((state) => state.view);
  const isContextLost = useStore((state) => state.isContextLost);
  const setWsConnected = useStore((state) => state.setWsConnected);
  const batchUpdatePartStates = useStore((state) => state.batchUpdatePartStates);

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

  const abortCurrentInteraction = useStore((state) => state.abortCurrentInteraction);
  const deselectAll = useStore((state) => state.deselectAll);
  const interactionPhase = useStore((state) => state.interactionPhase);
  const addStagedPart = useStore((state) => state.addStagedPart);
  const previewPart = useStore((state) => state.previewPart);
  const startFreePlacingTurntable = useStore((state) => state.startFreePlacingTurntable);

  // 搜索面板开/关状态。Issue #64 #1：从局部 useState 提到 store，让
  // useKeyboardDispatcher 单 handler 能 phase-aware 路由 Esc。
  const isSearchOpen = useStore((s) => s.isSearchOpen);
  const setSearchOpen = useStore((s) => s.setSearchOpen);

  // 唯一全局键盘 dispatcher。包揽 Cmd+K（开搜索） / Esc（按 phase 路由：
  // 搜索开则关搜索；FREE_PLACING commit；其他 abort+deselect） / 全部
  // 编辑快捷键。原 App.jsx 的 keydown useEffect 已并入。
  useKeyboardDispatcher();

  return (
    <div className="w-screen h-screen relative bg-slate-50 overflow-hidden">
      {/* 宏观策略：分视图渲染 UI，互不干扰 */}
      {view === 'EDITOR' ? <AssemblyUI /> : <LibraryNav />}

      {view === 'EDITOR' ? (
        <div className="w-full h-full" data-testid="assembly-canvas-container">
          {/* 主 R3F Canvas 加 data-testid 让 e2e 能跟 PartLibraryPanel 缩略图 /
              VerificationWorkbench 内部 canvas / DebugOverlay 子 canvas 精确区分。
              修自 issue #64 C.5：解决 page.locator('canvas') 全局至少匹配一个的可达性问题。 */}
          <Canvas
            camera={{ position: [0.15, 0.2, 0.25], fov: 45, near: 0.0001, far: 50 }}
            shadows
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
            className="w-full h-full"
            data-testid="assembly-canvas"
            onPointerMissed={(e) => {
                // 只响应鼠标左键点击底板空白处
                if (e.button === 0) {
                    if (interactionPhase === 'AXIAL_SLIDING') {
                        useStore.getState().commitAxialSliding();
                    } else if (interactionPhase !== 'IDLE') {
                        abortCurrentInteraction();
                    }
                    // 无论处于什么状态，点击空白处都应全局清空零件选中高亮状态
                    deselectAll();
                }
            }}
          >
            <Suspense fallback={<Html center><span>Loading…</span></Html>}>
              <WebGLRecoveryWatcher />
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
      <DebugOverlay />

      <RenderErrorBoundary 
        fallback={
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#2a2a2e]/90 backdrop-blur-sm text-white">
            <div className="bg-red-950/80 p-8 rounded-2xl border border-red-500/50 shadow-2xl max-w-md text-center">
              <svg className="w-12 h-12 text-red-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
              <h2 className="text-xl font-bold text-red-500 mb-2 tracking-wide">搜索模块异常</h2>
              <p className="text-red-200 text-sm mb-6 leading-relaxed">
                零件搜索组件渲染出错，为防止意外副作用，该模块已被阻断。
              </p>
              <button onClick={() => window.location.reload()} className="px-6 py-2 bg-red-600/80 text-red-100 rounded hover:bg-red-500 transition-colors tracking-wide font-medium">
                强制刷新上下文
              </button>
            </div>
          </div>
        }
      >
        <PartSearchDialog
          isOpen={isSearchOpen}
          onClose={() => setSearchOpen(false)}
          onSelectPart={(partNum) => {
            if (view === 'EDITOR') {
              const partId = partNum + ".dat";
              // 「整体转盘」：直接走组合放置（一次落两半、预连 revolute），不走单件预览。
              if (isTurntableAssemblyTop(partId)) {
                startFreePlacingTurntable?.(getDefaultColorCode(partId, 71));
                setSearchOpen(false);
                return;
              }
              // 添加到暂存区，并同时激活大弹窗预览模式
              addStagedPart?.({ part_id: partId });
              previewPart?.(partId);
            } else {
              console.log(`[Verify View] Selected Part: ${partNum}`);
              // TODO: 如果需要可以切换库校验面板到选中的零件
            }
          }}
        />
      </RenderErrorBoundary>

      {isContextLost && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#1a1a1c]/95 backdrop-blur-md text-white">
          <div className="bg-amber-950/80 p-8 rounded-3xl border border-amber-500/50 shadow-2xl max-w-md text-center">
            <svg className="w-16 h-16 text-amber-500 mx-auto mb-6 drop-shadow-[0_0_15px_rgba(245,158,11,0.5)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
            <h2 className="text-2xl font-black text-amber-400 mb-3 tracking-wider uppercase">WebGL Context Lost</h2>
            <p className="text-amber-200/80 text-sm mb-8 leading-relaxed font-medium">
              由于超出浏览器显存分配阈值限制，3D 画布渲染上下文已崩溃。
              为了防止脏数据写入，操作总线已强制挂起。
            </p>
            <button onClick={() => window.location.reload()} className="px-8 py-3 bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-white rounded-xl shadow-lg transition-all tracking-widest font-black uppercase text-xs">
              重启渲染管线
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

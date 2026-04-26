import re

with open("frontend/src/App.jsx", "r") as f:
    content = f.read()

app_code = """function App() {
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }
"""

replacement_code = """function MainApp() {
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

  // 全局搜索面板状态
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // 挂载全局 3D 快捷键监听
  useKeyboardShortcuts();

  // 键盘全局监听：专属的 Cmd+K 和 自定义事件
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Cmd+K 或 Ctrl+K 呼出快速搜索面板
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
      // 搜索面板打开时，Esc 键关面板
      if (e.key === 'Escape' && isSearchOpen) {
         e.preventDefault(); // 阻断传递给 useKeyboardShortcuts，这里用 stopPropagation 可能不行因为是分别绑在 window 的，依赖执行顺序。
         // 不过 React setState 本身处理无碍
         setIsSearchOpen(false);
      }
    };

    const handleOpenSearch = () => setIsSearchOpen(true);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('open-part-search', handleOpenSearch);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('open-part-search', handleOpenSearch);
    };
  }, [isSearchOpen]);

  return (
    <div className="w-screen h-screen relative bg-slate-50 overflow-hidden">
      {/* 宏观策略：分视图渲染 UI，互不干扰 */}
      {view === 'ASSEMBLY' ? <AssemblyUI /> : <LibraryNav />}

      {view === 'ASSEMBLY' ? (
        <div className="w-full h-full">
          <Canvas
            camera={{ position: [0.15, 0.2, 0.25], fov: 45, near: 0.0001, far: 50 }}
            shadows
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
            className="w-full h-full"
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
              <h2 className="text-xl font-bold text-red-500 mb-2 tracking-wide">核心依赖熔断</h2>
              <p className="text-red-200 text-sm mb-6 leading-relaxed">
                Meilisearch 搜索引擎未能通过启动验证或连接凭证失效，为防止意外副作用，该模块已被阻断。
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
          onClose={() => setIsSearchOpen(false)}
          onSelectPart={(partNum) => {
            if (view === 'ASSEMBLY') {
              const partId = partNum + ".dat";
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

function App() {
  if (window.location.pathname === '/generator') {
    return <ThumbnailGenerator />;
  }
  return <MainApp />;
}
"""

with open("frontend/src/App.jsx", "w") as f:
    # First split everything after `function App() {`
    parts = content.split("function App() {")
    before_app = parts[0]

    # We reconstruct the file
    f.write(before_app + replacement_code + "\nexport default App;\n")

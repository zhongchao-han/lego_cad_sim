import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { CameraControls, Html } from '@react-three/drei';
import { useStore } from '../store';
import { InteractivePart } from './InteractivePart';
import { X, MousePointer2, Palette } from 'lucide-react';
import { getDefaultColorCode } from '../utils/partColorDefaults';

/** 常用 LDraw 颜色 */
const PALETTE: ReadonlyArray<{ code: number; hex: string; name: string }> = [
  { code: 0,   hex: '#212121', name: 'Black' },
  { code: 1,   hex: '#1565C0', name: 'Blue' },
  { code: 2,   hex: '#388E3C', name: 'Green' },
  { code: 4,   hex: '#D32F2F', name: 'Red' },
  { code: 6,   hex: '#4E342E', name: 'Brown' },
  { code: 7,   hex: '#9E9E9E', name: 'Light Gray' },
  { code: 8,   hex: '#455A64', name: 'Dark Gray' },
  { code: 14,  hex: '#FDD835', name: 'Yellow' },
  { code: 15,  hex: '#FFFFFF', name: 'White' },
  { code: 25,  hex: '#FF8F00', name: 'Orange' },
  { code: 70,  hex: '#6D4C41', name: 'Reddish Brown' },
  { code: 71,  hex: '#B0BEC5', name: 'Lt Bluish Gray' },
  { code: 72,  hex: '#546E7A', name: 'Dk Bluish Gray' },
] as const;

export function PartPreviewOverlay() {
  const previewPartId = useStore((s) => s.previewPartId);
  const activeColorCode = useStore((s) => s.activeColorCode);
  const setActiveColorCode = useStore((s) => s.setActiveColorCode);
  
  const handlePortClick = useStore((s) => s.handlePortClick);
  const setPreviewPartId = (id: string | null) => useStore.setState({ previewPartId: id });
  const clearPhase = () => useStore.setState({ interactionPhase: 'IDLE' as any });

  // 计算当前预览零件的最终展示颜色（字典优先 > 画笔色）
  const resolvedColor = useMemo(() => {
    if (!previewPartId) return activeColorCode;
    return getDefaultColorCode(previewPartId, activeColorCode);
  }, [previewPartId, activeColorCode]);

  const isAutoColor = useMemo(() => {
    if (!previewPartId) return false;
    return getDefaultColorCode(previewPartId, activeColorCode) !== activeColorCode;
  }, [previewPartId, activeColorCode]);

  if (!previewPartId) return null;

  const handleClose = () => {
    setPreviewPartId(null);
    clearPhase();
  };

  const onPortSelected = async (portInfo: any) => {
    // 为即将加入场景的零件生成唯一标识位 (InstanceID)
    const instanceId = `${previewPartId}_${window.crypto.randomUUID().substring(0,8)}`;
    await handlePortClick({
      ...portInfo,
      partId: instanceId,
      ldrawId: previewPartId, // 保存原始材质 ID
      isFromPreview: true // 标记来源，用于激活连续插入(Stamp)模式
    });
  };

  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center pointer-events-none">
      <div className="bg-black/40 backdrop-blur-sm absolute inset-0" onClick={handleClose} />
      
      <div className="bg-white rounded-2xl shadow-2xl w-[90vw] max-w-[860px] h-[520px] flex pointer-events-auto relative ring-1 ring-black/10 overflow-hidden">
        
        {/* 左侧：3D 预览区 */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-slate-200">
          <div className="p-4 flex items-center justify-between border-b bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                  <MousePointer2 className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="font-bold text-slate-800">Assign Source Port</h3>
                <p className="text-[10px] text-slate-400 font-mono tracking-tighter">PREVIEW: {previewPartId}</p>
              </div>
            </div>
            {/* 移动端关闭按钮（可选） */}
          </div>

          <div className="flex-1 relative bg-slate-100">
            <Canvas
               camera={{ position: [0.05, 0.05, 0.05], fov: 35, near: 0.001, far: 50 }}
               className="w-full h-full"
             >
               <Suspense fallback={
                 <Html center>
                   <div className="animate-pulse text-xs text-slate-400">Loading model...</div>
                 </Html>
               }>
                 <ambientLight intensity={0.7} />
                 <directionalLight position={[1, 2, 3]} intensity={1.5} />
                 <directionalLight position={[-2, 1, -1]} intensity={0.6} />

                 <InteractivePart 
                   partId={previewPartId} 
                   colorCode={resolvedColor}
                   onPortClick={onPortSelected}
                   isStatic={true}
                   opacity={0.8}
                   autoCenter={true} 
                 />
                 
                 <CameraControls 
                   makeDefault 
                   minDistance={0.001} 
                   maxDistance={5.0} 
                   dollySpeed={5} 
                   azimuthRotateSpeed={1.5} 
                   polarRotateSpeed={1.5} 
                   smoothTime={0.25} 
                 />
               </Suspense>
             </Canvas>
             
             <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur px-4 py-2 rounded-full border shadow-sm pointer-events-auto flex gap-4 items-center">
                <span className="text-xs font-semibold text-slate-600">
                  Click a port to Snap, or
                </span>
                <button
                  onClick={() => useStore.getState().startFreePlacing(previewPartId, resolvedColor)}
                  className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs font-bold rounded shadow transition-colors"
                >
                  Drop to Ground
                </button>
             </div>
          </div>
        </div>

        {/* 右侧：属性与颜色配置面板 */}
        <div className="w-56 shrink-0 bg-white flex flex-col">
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-bold text-slate-800 flex items-center gap-2">
              <Palette className="w-4 h-4 text-blue-500" />
              Appearance
            </h3>
            <button 
              onClick={handleClose}
              className="p-1 hover:bg-slate-100 rounded-md transition-colors text-slate-400"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-4 flex-1 overflow-y-auto">
            <div className="mb-4">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Part Color</p>
              
              {isAutoColor ? (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs text-amber-800 font-semibold flex items-center gap-1.5 mb-1.5">
                    ⚡ Classic Preset
                  </p>
                  <p className="text-[10px] text-amber-600/80 leading-relaxed">
                    This is a highly specific Technic part. Its color is locked to its real-world functional default (#{resolvedColor}).
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-[10px] text-slate-400 mb-3">
                    Select a color for this instance before dropping it into the assembly.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {PALETTE.map(({ code, hex, name }) => {
                      const isActive = code === activeColorCode;
                      return (
                        <button
                          key={code}
                          title={`${name} (LDraw #${code})`}
                          onClick={() => setActiveColorCode(code)}
                          style={{ backgroundColor: hex }}
                          className={`
                            w-8 h-8 rounded-full transition-all duration-150 shrink-0
                            ${isActive
                              ? 'ring-2 ring-blue-500 ring-offset-2 shadow-md scale-110'
                              : 'hover:scale-110 hover:ring-1 hover:ring-slate-400/50 opacity-80 hover:opacity-100'
                            }
                            ${hex === '#FFFFFF' ? 'border border-slate-300' : ''}
                          `}
                        />
                      );
                    })}
                  </div>
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <p className="text-[10px] font-mono text-slate-400">Selected: LDraw Color #{activeColorCode}</p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        
      </div>
    </div>
  );
}

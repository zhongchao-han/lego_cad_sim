import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { CameraControls, Html } from '@react-three/drei';
import { useStore } from '../store';
import { PreviewModel } from './PreviewModel';
import { X, MousePointer2 } from 'lucide-react';
import { getDefaultColorCode } from '../utils/partColorDefaults';
import { FreePlacingProjectionMode } from '../types';
import { isTurntableAssemblyTop, turntableBaseFor } from '../utils/turntableAssembly';

export function PartPreviewOverlay() {
  const previewPartId = useStore((s) => s.previewPartId);
  const activeColorCode = useStore((s) => s.activeColorCode);

  const handlePortClick = useStore((s) => s.handlePortClick);
  const startFreePlacingTurntable = useStore((s) => s.startFreePlacingTurntable);
  const setPreviewPartId = (id: string | null) => useStore.setState({ previewPartId: id });
  const clearPhase = () => useStore.setState({ interactionPhase: 'IDLE' as any });

  // 当前预览零件的固定惯例色（全锁；库外件回退画笔色）。用于预览渲染与落地放置。
  const resolvedColor = useMemo(() => {
    if (!previewPartId) return activeColorCode;
    return getDefaultColorCode(previewPartId, activeColorCode);
  }, [previewPartId, activeColorCode]);

  if (!previewPartId) return null;

  const handleClose = () => {
    setPreviewPartId(null);
    clearPhase();
  };

  const onPortSelected = async (portInfo: any) => {
    // 「整体转盘」：不按单个端口 snap（那只会落顶半），改为整体落地放置（两半同轴预连）。
    if (previewPartId && isTurntableAssemblyTop(previewPartId)) {
      const base = turntableBaseFor(previewPartId);
      if (base) { startFreePlacingTurntable(previewPartId, base, resolvedColor); return; }
    }
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
        
        {/* 3D 预览区（单栏；零件颜色按惯例全锁，无配色面板） */}
        <div className="flex-1 min-w-0 flex flex-col">
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
            <button
              onClick={handleClose}
              className="p-1 hover:bg-slate-100 rounded-md transition-colors text-slate-400"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
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

                 <PreviewModel
                   partId={previewPartId}
                   colorCode={resolvedColor}
                   onPortClick={onPortSelected}
                   isStatic={true}
                   opacity={0.8}
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
                  onClick={(e) => {
                    // 「整体转盘」：落地放下两半（同轴、预连 revolute），而非单件。
                    const base = turntableBaseFor(previewPartId);
                    if (base) {
                      startFreePlacingTurntable(previewPartId, base, resolvedColor, {
                        pointer: { clientX: e.clientX, clientY: e.clientY },
                      });
                      return;
                    }
                    // UX 反馈修复：不再把模态相机朝向带进落地姿态（会让 orbit 过
                    // 视角的零件落地歪斜）。零件一律以原始姿态（平躺）落地，可预期。
                    useStore.getState().startFreePlacing(
                      previewPartId,
                      resolvedColor,
                      {
                        pointer: { clientX: e.clientX, clientY: e.clientY },
                        projectionMode: FreePlacingProjectionMode.GROUND_PLANE,
                      }
                    );
                  }}
                  className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs font-bold rounded shadow transition-colors"
                >
                  Drop to Ground
                </button>
             </div>
          </div>
        </div>

      </div>
    </div>
  );
}

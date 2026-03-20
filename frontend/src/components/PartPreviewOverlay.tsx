import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Environment, CameraControls, Html } from '@react-three/drei';
import { useStore } from '../store';
import { InteractivePart } from './InteractivePart';
import { X, MousePointer2 } from 'lucide-react';

export function PartPreviewOverlay() {
  const previewPartId = useStore((s) => s.previewPartId);
  const handlePortClick = useStore((s) => s.handlePortClick);
  const setPreviewPartId = (id: string | null) => useStore.setState({ previewPartId: id });
  const clearPhase = () => useStore.setState({ interactionPhase: 'IDLE' as any });

  if (!previewPartId) return null;

  const handleClose = () => {
    setPreviewPartId(null);
    clearPhase();
  };

  const onPortSelected = async (portInfo: any) => {
    // 为即将加入场景的零件生成唯一标识位 (InstanceID)
    const instanceId = `${previewPartId}_${Date.now()}`;
    await handlePortClick({
      ...portInfo,
      partId: instanceId,
      ldrawId: previewPartId, // 保存原始材质 ID
    });
  };

  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center pointer-events-none">
      <div className="bg-black/40 backdrop-blur-sm absolute inset-0" onClick={handleClose} />
      
      <div className="bg-white rounded-2xl shadow-2xl w-[600px] h-[500px] flex flex-col pointer-events-auto relative overflow-hidden ring-1 ring-black/10">
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
            className="p-2 hover:bg-slate-200 rounded-full transition-colors text-slate-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 relative bg-slate-100">
           <Canvas
             camera={{ position: [0.08, 0.08, 0.08], fov: 35 }}
             className="w-full h-full"
           >
             <Suspense fallback={
               <Html center>
                 <div className="animate-pulse text-xs text-slate-400">Loading model...</div>
               </Html>
             }>
               <Environment preset="city" />
               <ambientLight intensity={0.5} />
               <directionalLight position={[1, 2, 3]} intensity={1.5} />
               
               <InteractivePart 
                 partId={previewPartId} 
                 onPortClick={onPortSelected}
                 isStatic={true} // 静态零件，点击直接返回局部坐标
               />
               
               <CameraControls makeDefault minDistance={0.02} maxDistance={0.5} />
             </Suspense>
           </Canvas>
           
           <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur px-4 py-2 rounded-full border shadow-sm pointer-events-none">
              <span className="text-xs font-semibold text-slate-600">
                Rotate to find a port. Click a port to select.
              </span>
           </div>
        </div>
      </div>
    </div>
  );
}

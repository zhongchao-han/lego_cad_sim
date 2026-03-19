import React, { useEffect, useState, useMemo, Suspense } from 'react';
import * as THREE from 'three';
import { useVerificationStore } from './verificationStore';
import { PortVisualizer } from './PortVisualizer.tsx';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, Stage, useGLTF, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { useLDrawPart } from './useLDrawPart';

/**
 * 内部组件：负责加载和渲染单个零件模型
 */
const PartModel: React.FC<{ url: string }> = ({ url }) => {
  const fullUrl = `http://127.0.0.1:8000${url}`;
  const { scene } = useGLTF(fullUrl);
  
  const processedScene = useMemo(() => {
    const clone = scene.clone();
    clone.traverse((child) => {
      if ((child as any).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.material = (mesh.material as any).clone();
        (mesh.material as any).transparent = true;
        (mesh.material as any).opacity = 0.4;
        (mesh.material as any).depthWrite = false;
      }
    });
    return clone;
  }, [scene]);

  return <primitive object={processedScene} pointerEvents="none" />;
};

export const VerificationWorkbench: React.FC = () => {
  const { 
    pendingList, currentPartId, currentPorts, fetchPendingList, 
    selectPart, addPort, deletePort, movePort, flipPortZ, rotatePort90, 
    snapPortToGrid, saveVerification 
  } = useVerificationStore();

  const { meshUrl } = useLDrawPart(currentPartId);
  const [selectedPortIndex, setSelectedPortIndex] = useState<number | null>(null);

  useEffect(() => {
    fetchPendingList();
  }, [fetchPendingList]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: '#111', color: 'white' }}>
      {/* 侧边栏：待复核列表 */}
      <div style={{ 
        width: '300px', 
        borderRight: '1px solid #333', 
        overflowY: 'auto', 
        padding: '1rem',
        paddingTop: '150px' 
      }}>
        <h3 className="text-lg font-bold mb-4">待复核零件 ({pendingList.length})</h3>
        {pendingList.map(part => (
          <div 
            key={part.part_id}
            onClick={() => {
              selectPart(part.part_id);
              setSelectedPortIndex(null);
            }}
            style={{ 
              padding: '0.75rem', cursor: 'pointer', 
              background: currentPartId === part.part_id ? '#2563eb' : 'transparent',
              borderBottom: '1px solid #222',
              borderRadius: '4px',
              marginBottom: '4px'
            }}
          >
            <div className="font-medium">{part.part_id}</div>
            <div style={{ fontSize: '0.75rem', color: currentPartId === part.part_id ? '#bfdbfe' : '#888' }}>
              自信度: {part.confidence} | 端口: {part.port_count}
            </div>
          </div>
        ))}

        {currentPartId && (
          <div className="mt-8 space-y-2 border-t border-gray-700 pt-4">
            <p className="text-xs font-bold text-gray-500 uppercase">手动添加端口</p>
            <button 
              onClick={() => addPort('peghole')}
              className="w-full py-2 bg-blue-900/50 hover:bg-blue-800 text-blue-300 text-sm font-bold rounded border border-blue-700 transition-colors"
            >
              + Add Hole (蓝色)
            </button>
            <button 
              onClick={() => addPort('peg')}
              className="w-full py-2 bg-purple-900/50 hover:bg-purple-800 text-purple-300 text-sm font-bold rounded border border-purple-700 transition-colors"
            >
              + Add Peg (紫色)
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <Canvas camera={{ position: [0.08, 0.08, 0.08], fov: 50, near: 0.0001, far: 10 }}>
          <Suspense fallback={null}>
            {/* 核心修复：center={false} 确保模型不发生位移，旋转中心保持在 LDraw 原点 */}
            <Stage intensity={0.5} environment="city" adjustCamera={false} center={false}>
              {/* 原点坐标轴：X(红) Y(绿) Z(蓝) */}
              <axesHelper args={[0.05]} />

              {/* 渲染零件主体 */}
              {meshUrl && <PartModel url={meshUrl} />}

              {/* 渲染端口 Gizmo */}
              {currentPorts.map((port, idx) => (
                <PortVisualizer 
                  key={`${currentPartId}-${idx}`}
                  {...port}
                  isSelected={selectedPortIndex === idx}
                  onSelect={() => setSelectedPortIndex(idx)}
                />
              ))}
            </Stage>
          </Suspense>
          <Grid infiniteGrid fadeDistance={0.5} cellColor="#333" sectionColor="#444" />
          
          {/* 方向罗盘 */}
          <GizmoHelper alignment="bottom-right" margin={[100, 100]}>
            <GizmoViewport axisColors={['#ff3e3e', '#3fff3e', '#3e3eff']} labelColor="white" />
          </GizmoHelper>

          {/* 核心修复：target 锁死在 [0,0,0]，enablePan=false 防止旋转中心漂移 */}
          <OrbitControls makeDefault target={[0, 0, 0]} enablePan={false} minDistance={0.001} maxDistance={1} />
        </Canvas>

        {/* 修正工具箱 */}
        {selectedPortIndex !== null && (
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-black/90 backdrop-blur p-6 rounded-2xl shadow-2xl border border-white/10 space-y-4">
            <div className="flex gap-2 justify-center">
              <button className="px-3 py-1 bg-red-900 hover:bg-red-700 text-white text-xs font-bold rounded"
                onClick={() => { deletePort(selectedPortIndex); setSelectedPortIndex(null); }}>
                DELETE PORT
              </button>
            </div>
            
            <div className="flex gap-3">
              <button className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs font-bold"
                onClick={() => flipPortZ(selectedPortIndex)}>Flip Z (180°)</button>
              <button className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs font-bold"
                onClick={() => rotatePort90(selectedPortIndex)}>Rotate (90°)</button>
              <button className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-bold"
                onClick={() => snapPortToGrid(selectedPortIndex)}>Snap to Grid</button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map(axis => (
                <div key={axis} className="flex flex-col items-center gap-1">
                  <span className="text-[10px] text-gray-500 font-bold">{['X', 'Y', 'Z'][axis]} 移动</span>
                  <div className="flex gap-1">
                    <button className="w-8 h-8 bg-gray-800 hover:bg-gray-700 rounded text-sm font-bold"
                      onClick={() => movePort(selectedPortIndex, axis as any, 10)}>+</button>
                    <button className="w-8 h-8 bg-gray-800 hover:bg-gray-700 rounded text-sm font-bold"
                      onClick={() => movePort(selectedPortIndex, axis as any, -10)}>-</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {currentPartId && (
          <button 
            onClick={saveVerification}
            className="absolute top-6 right-6 px-6 py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg shadow-lg transition-all"
          >
            完成并提交复核
          </button>
        )}
        
        {!currentPartId && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-gray-500 text-xl font-bold">
            请从左侧选择一个零件进行复核
          </div>
        )}
      </div>
    </div>
  );
};

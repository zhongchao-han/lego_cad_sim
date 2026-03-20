import React, { useEffect, useState, useMemo, Suspense } from 'react';
import * as THREE from 'three';
import { useVerificationStore } from './verificationStore';
import { PortVisualizer } from './PortVisualizer.tsx';
import { Canvas } from '@react-three/fiber';
import { CameraControls, Grid, Environment, useGLTF, GizmoHelper, GizmoViewport, Html, Stats } from '@react-three/drei';
import { useLDrawPart } from './useLDrawPart';
import { CameraController } from './CameraController';
import { calculateWorkbenchTarget, LDU } from './cameraUtils';

/**
 * 内部组件：负责加载和渲染单个零件模型
 */
const PartModel: React.FC<{ url: string }> = ({ url }) => {
  const fullUrl = encodeURI(`http://127.0.0.1:8000${url}`);
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
        mesh.raycast = () => null; // 绝对禁止模型阻挡射线检测
      }
    });
    return clone;
  }, [scene]);

  return <primitive object={processedScene} pointerEvents="none" />;
};

export const VerificationWorkbench: React.FC = () => {
  const { 
    pendingList, searchList, currentPartId, currentPorts, fetchPendingList, searchParts,
    selectPart, addPort, deletePort, movePort, flipPortZ, rotateX90, rotateY90, rotateZ90, 
    snapPortToGrid, saveVerification 
  } = useVerificationStore();

  const [searchQuery, setSearchQuery] = useState('');
  const { meshUrl } = useLDrawPart(currentPartId);

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      searchParts(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchParts]);

  const listData = searchQuery ? searchList : pendingList;

  const [selectedPortIndex, setSelectedPortIndex] = useState<number | null>(null);

  const target = useMemo(() => {
    return calculateWorkbenchTarget(currentPorts[selectedPortIndex!]);
  }, [selectedPortIndex, currentPorts]);


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
        paddingTop: '180px' 
      }}>
        <div className="mb-6">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-2">搜索零件</h3>
          <input 
            type="text" 
            placeholder="零件 ID (如 6558)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-sm focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        <h3 className="text-lg font-bold mb-4">
          {searchQuery ? '搜索结果' : '待复核清单'} ({listData.length})
        </h3>
        
        {listData.map(part => (
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
              marginBottom: '4px',
              opacity: (part as any).status === 'verified' ? 0.7 : 1
            }}
          >
            <div className="flex justify-between items-center">
              <span className="font-medium">{part.part_id}</span>
              {(part as any).status === 'verified' && (
                <span className="text-[10px] bg-green-900 text-green-200 px-1 rounded">已复核</span>
              )}
            </div>
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
              + 添加 Hole (蓝色)
            </button>
            <button 
              onClick={() => addPort('peg')}
              className="w-full py-2 bg-purple-900/50 hover:bg-purple-800 text-purple-300 text-sm font-bold rounded border border-purple-700 transition-colors"
            >
              + 添加 Peg (紫色)
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <Canvas camera={{ position: [0.08, 0.08, 0.08], fov: 50, near: 0.0001, far: 10 }} onPointerMissed={() => setSelectedPortIndex(null)}>
          <Stats /> {/* 添加性能监控方便定位 */}
          <Suspense fallback={<Html center><div className="text-blue-400 animate-pulse">加载 3D 模型中...</div></Html>}>
            <ambientLight intensity={1.5} />
            <directionalLight position={[1, 1, 1]} intensity={0.8} />
            <Environment preset="city" />

            {/* 原点坐标轴：X(红) Y(绿) Z(蓝) - 禁用交互以防阻挡端口选择 */}
            <axesHelper args={[0.05]} raycast={() => null} />

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
          </Suspense>
          <Grid infiniteGrid fadeDistance={0.5} cellColor="#333" sectionColor="#444" raycast={() => null} />
          
          {/* 方向罗盘 */}
          <GizmoHelper alignment="bottom-right" margin={[100, 100]}>
            <GizmoViewport axisColors={['#ff3e3e', '#3fff3e', '#3e3eff']} labelColor="white" />
          </GizmoHelper>

          <CameraController 
            target={target} 
            minDistance={0.001} 
            maxDistance={1} 
            mouseButtons={{ left: 1, middle: 0, right: 2, wheel: 8 }}
          />
        </Canvas>

        {/* 修正工具箱 */}
        {selectedPortIndex !== null && (
          <div 
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-black/90 backdrop-blur p-6 rounded-2xl shadow-2xl border border-white/10 space-y-4"
          >
            <div className="flex gap-2 justify-center">
              <button className="px-3 py-1 bg-red-900/80 hover:bg-red-700 text-white text-xs font-bold rounded"
                onClick={() => { deletePort(selectedPortIndex); setSelectedPortIndex(null); }}>
                DELETE (删除端口)
              </button>
            </div>
            
            <div className="flex gap-3">
              <button className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-bold"
                onClick={() => flipPortZ(selectedPortIndex)}>Flip Z (180°翻转)</button>
              <button className="px-3 py-2 bg-indigo-700 hover:bg-indigo-600 rounded-lg text-xs font-bold"
                onClick={() => rotateX90(selectedPortIndex)}>旋转 X</button>
              <button className="px-3 py-2 bg-indigo-700 hover:bg-indigo-600 rounded-lg text-xs font-bold"
                onClick={() => rotateY90(selectedPortIndex)}>旋转 Y</button>
              <button className="px-3 py-2 bg-indigo-700 hover:bg-indigo-600 rounded-lg text-xs font-bold"
                onClick={() => rotateZ90(selectedPortIndex)}>旋转 Z (90°)</button>
              <button className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-bold"
                onClick={() => snapPortToGrid(selectedPortIndex)}>Grid吸附</button>
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

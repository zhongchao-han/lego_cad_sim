import React, { useEffect, useState, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { useGLTF, Environment } from '@react-three/drei';
import * as THREE from 'three';
import axios from 'axios';
import { LDrawMeshRenderer } from './components/LDrawMeshRenderer';

const BACKEND_ORIGIN = ((import.meta as unknown as Record<string, Record<string, string>>).env?.['VITE_BACKEND_ORIGIN']) || 'http://127.0.0.1:8000';

function ModelViewer({ partId, meshUrl, onRendered }: { partId: string, meshUrl: string, onRendered: () => void }) {
  const { scene: gltfScene } = useGLTF(meshUrl);
  const { scene: threeScene, camera, gl } = useThree();

  useEffect(() => {
    if (!gltfScene) return;
    
    // 1. Precise algorithmic bounds framing
    const box = new THREE.Box3().setFromObject(gltfScene);
    const center = box.getCenter(new THREE.Vector3());

    const distance = 100; // Place camera far enough to avoid frustum clipping
    
    // Set an isometric angle looking down and left
    camera.position.set(center.x + distance * 0.8, center.y + distance, center.z + distance * 0.8);
    camera.lookAt(center);
    
    // Construct absolute non-distorting boundaries (Orthographic tight-fit)
    if (camera instanceof THREE.OrthographicCamera) {
       camera.near = 0.001;
       camera.far = distance * 2;
       camera.updateMatrixWorld();
       
       const corners = [
           new THREE.Vector3(box.min.x, box.min.y, box.min.z),
           new THREE.Vector3(box.max.x, box.min.y, box.min.z),
           new THREE.Vector3(box.min.x, box.max.y, box.min.z),
           new THREE.Vector3(box.max.x, box.max.y, box.min.z),
           new THREE.Vector3(box.min.x, box.min.y, box.max.z),
           new THREE.Vector3(box.max.x, box.min.y, box.max.z),
           new THREE.Vector3(box.min.x, box.max.y, box.max.z),
           new THREE.Vector3(box.max.x, box.max.y, box.max.z)
       ];

       const camInv = camera.matrixWorldInverse;
       let minX = Infinity, maxX = -Infinity;
       let minY = Infinity, maxY = -Infinity;

       corners.forEach(c => {
           const p = c.clone().applyMatrix4(camInv);
           if(p.x < minX) minX = p.x;
           if(p.x > maxX) maxX = p.x;
           if(p.y < minY) minY = p.y;
           if(p.y > maxY) maxY = p.y;
       });

       const spanX = maxX - minX;
       const spanY = maxY - minY;
       const maxSpan = Math.max(spanX, spanY) * 1.1; // 10% safe padding
       
       camera.left = -maxSpan / 2;
       camera.right = maxSpan / 2;
       camera.top = maxSpan / 2;
       camera.bottom = -maxSpan / 2;

       // Mathematically lock the view to the center of the projected shape
       const offX = (minX + maxX) / 2;
       const offY = (minY + maxY) / 2;
       camera.translateX(offX);
       camera.translateY(offY);
       
       camera.zoom = 1;
       camera.updateProjectionMatrix();
    }

    // 2. Wait exactly 2 render loops to ensure Shaders converge and frame paints to GPU
    let frames = 0;
    const animate = () => {
      // Force render context update USING THE GLOBAL LIT SCENE, not the raw gltf sub-tree!
      gl.render(threeScene, camera);
      frames++;
      if (frames >= 3) {
        onRendered();
      } else {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);

  }, [gltfScene, threeScene, camera, gl, onRendered]);

  return (
    <group>
      {/* 软光源营造高质感 LDraw 预设阴影 - 调低强度以防过曝 */}
      <ambientLight intensity={0.7} />
      <directionalLight position={[10, 20, 10]} intensity={1.1} castShadow />
      <directionalLight position={[-10, 10, -10]} intensity={0.4} />
      
      <LDrawMeshRenderer url={meshUrl} />

      <Environment frames={1} resolution={256}>
        <group>
          <mesh position={[0, 5, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[10, 10]} />
            <meshBasicMaterial color="white" />
          </mesh>
          <mesh position={[5, 0, 2]} rotation={[0, -Math.PI / 2, 0]}>
            <planeGeometry args={[10, 10]} />
            <meshBasicMaterial color="white" />
          </mesh>
          <mesh position={[-5, 0, -2]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[10, 10]} />
            <meshBasicMaterial color="white" />
          </mesh>
        </group>
      </Environment>
    </group>
  );
}

export function ThumbnailGenerator() {
  const [parts, setParts] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentMeshUrl, setCurrentMeshUrl] = useState<string | null>(null);
  const [missingOnly, setMissingOnly] = useState<boolean>(true); // 开启防御性：默认只生成不存在图库的零件
  
  const [logs, setLogs] = useState<string[]>([]);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // 强制依赖 missingOnly 并将布尔参数直接传给后端
    axios.get(`${BACKEND_ORIGIN}/api/all_parts?missing_only=${missingOnly}`).then(res => {
      setParts(res.data);
    }).catch(err => {
      setLogs(p => [...p, `[ERROR] URL Fetch failed: ${err}`]);
    });
  }, [missingOnly]);

  const addLog = (msg: string) => {
    setLogs(p => [msg, ...p].slice(0, 50));
  };

  const startBatch = async () => {
    if (parts.length === 0) return;
    setIsProcessing(true);
    setCurrentIndex(0);
    processPart(0);
  };

  const processPart = async (idx: number) => {
    if (idx >= parts.length) {
      addLog('✅ ALL PARTS RENDERED SUCCESSFULLY!');
      setIsProcessing(false);
      return;
    }
    
    const partId = parts[idx];
    addLog(`[FETCH] Resolving backend GLB for ${partId}...`);
    
    try {
      // 改用 color=1 (经典乐高科技蓝)，提供极佳的几何对比度与工程感
      const res = await axios.get(`${BACKEND_ORIGIN}/api/ldraw_part/${partId}?color=1`, { timeout: 30000 });
      const url = res.data.mesh_url;
      if (url) {
        // This will mount the model, which computes bounds, positions camera, and calls captureSnapshot
        setCurrentMeshUrl(`${BACKEND_ORIGIN}${url}`);
      } else {
        addLog(`[SKIP] No mesh URL returned for ${partId}`);
        processNext(idx);
      }
    } catch (e) {
      addLog(`[ERROR] Backend conversion failed for ${partId}. Skipping.`);
      processNext(idx);
    }
  };

  const processNext = (idx: number) => {
    const nextIdx = idx + 1;
    setCurrentIndex(nextIdx);
    // Timeout breaks the React call stack to avoid Maximum Call Stack Exceeded
    setTimeout(() => {
      processPart(nextIdx);
    }, 100);
  };

  const captureSnapshot = async () => {
    if (!canvasRef.current) return;
    const currentPart = parts[currentIndex];

    // Read hardware-accelerated buffer directly into binary Blob
    canvasRef.current.toBlob(async (blob) => {
      if (!blob) {
         addLog(`[FAIL] gl.readPixels yielded empty Blob for ${currentPart}`);
         processNext(currentIndex);
         return;
      }
      
      const formData = new FormData();
      formData.append('part_id', currentPart);
      // Give it a dummy filename required by standard FormData
      formData.append('file', blob, `${currentPart}.png`);

      try {
        await axios.post(`${BACKEND_ORIGIN}/api/tools/upload_thumbnail`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
        addLog(`[SUCCESS] 📸 Bounded and Saved: ${currentPart}`);
      } catch (err) {
        addLog(`[ERROR] Save POST dropped for ${currentPart}`);
      }

      // Cleanup threejs memory map for this part before continuing
      useGLTF.clear(`${BACKEND_ORIGIN}${currentMeshUrl}`);
      setCurrentMeshUrl(null);
      
      processNext(currentIndex);
    }, 'image/png');
  };

  return (
    <div className="flex flex-col h-screen w-full bg-slate-900 text-slate-100 p-8">
      <div className="flex justify-between items-center mb-8 border-b border-slate-700 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">GPU Thumbnail Batch Generator</h1>
          <p className="text-sm text-slate-400 mt-1">Found {parts.length} geometries queued for rendering context.</p>
        </div>
        <div className="flex items-center space-x-6">
          <label className="flex items-center space-x-2 text-sm font-semibold text-slate-300 cursor-pointer select-none">
            <input 
              type="checkbox" 
              disabled={isProcessing}
              checked={missingOnly} 
              onChange={e => setMissingOnly(e.target.checked)}
              className="w-4 h-4 bg-slate-800 border border-slate-400 rounded focus:ring-blue-500 cursor-pointer transition-colors"
            />
            <span>Skip Existing Images (Delta Sync)</span>
          </label>
          <button 
            onClick={startBatch}
            disabled={isProcessing || parts.length === 0}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold rounded-md shadow-lg transition-all"
          >
            {isProcessing ? `Rendering... (${currentIndex}/${parts.length})` : 'Start GPU Batch Engine'}
          </button>
        </div>
      </div>

      <div className="flex gap-8 h-full">
        {/* Left Side: Strict 256x256 Hardware Target */}
        <div className="flex flex-col items-center justify-center shrink-0 w-80 bg-slate-800 rounded-xl border border-slate-700 shadow-inner">
           <p className="text-xs text-slate-500 mb-4 font-mono">256x256 RAW FRAMEBUFFER</p>
           
           <div className="w-[256px] h-[256px] bg-black rounded overflow-hidden shadow-2xl relative pointer-events-none">
              {/* preserveDrawingBuffer=true IS CRITICAL for canvas.toBlob() payload sync */}
              <Canvas 
                ref={canvasRef}
                orthographic
                gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true }}
              >
                {currentMeshUrl && (
                   <ModelViewer 
                     partId={parts[currentIndex]} 
                     meshUrl={currentMeshUrl} 
                     onRendered={captureSnapshot} 
                   />
                )}
              </Canvas>
              {!currentMeshUrl && isProcessing && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                   <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"/>
                </div>
              )}
           </div>

           {isProcessing && (
             <div className="mt-8 text-center text-blue-400 font-mono text-sm leading-tight">
               Processing Element:<br/>
               <span className="text-xl text-white font-bold">{parts[currentIndex]}</span>
             </div>
           )}
        </div>

        {/* Right Side: Execution Logs */}
        <div className="flex-1 bg-black rounded-xl p-4 font-mono text-[11px] overflow-y-auto leading-relaxed border border-slate-800 shadow-inner">
           {logs.map((log, i) => (
             <div key={i} className={
               log.includes('[SUCCESS]') ? 'text-green-400' :
               log.includes('[ERROR]') ? 'text-red-400' :
               log.includes('[SKIP]') ? 'text-amber-400' :
               'text-slate-400'
             }>
               <span className="opacity-50 select-none mr-2">[{new Date().toISOString().split('T')[1].slice(0,-1)}]</span>
               {log}
             </div>
           ))}
           {logs.length === 0 && (
             <div className="text-slate-600 opacity-50 flex h-full items-center justify-center h-full">System Ready. Awaiting ignition.</div>
           )}
        </div>
      </div>
    </div>
  );
}

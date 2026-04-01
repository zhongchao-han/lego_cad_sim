import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface AutoFitCameraProps {
  targetRef: React.RefObject<THREE.Object3D | THREE.Group | null>;
  enabled?: boolean;
}

/**
 * AutoFitCamera.tsx
 * =================
 * 独立组件 (单一职责原则)：负责自动计算目标 3D 对象的包围盒，
 * 并驱动现有的 CameraControls 进行平滑的视角缩放与平移，使其完美包裹对象。
 */
export function AutoFitCamera({ targetRef, enabled = true }: AutoFitCameraProps) {
  const hasFitted = useRef(false);

  // 依赖变化时重置适配状态
  useEffect(() => {
    hasFitted.current = false;
  }, [targetRef, enabled]);

  // 利用逐帧检测，等待模型被完全解析并且挂载在场景图中 (bounding box 非空且尺寸有效) 时进行对焦。
  // 这避免了 setTimeout 导致的硬阻塞、时序竞争和 bounding box 空值问题。
  useFrame((state) => {
    const controls = state.controls;
    if (!enabled || !controls || !targetRef.current || hasFitted.current) return;

    const targetObj = targetRef.current;
    
    // 强制更新当前物体的世界矩阵，确保 Bounding Box 是最高精度的物理真实体积
    targetObj.updateWorldMatrix(true, true);
    
    const box = new THREE.Box3().setFromObject(targetObj);
    
    if (!box.isEmpty()) {
      const size = new THREE.Vector3();
      box.getSize(size);
      
      // 只有当有真实物理尺寸加载完成时才触发
      if (size.length() > 0 && typeof (controls as any).fitToBox === 'function') {
        hasFitted.current = true;
        // 按照对象物理尺寸的 5% 留出留白，原先是 15% 导致零件整体看起来可能太小
        const pad = Math.max(size.x, Math.max(size.y, size.z)) * 0.05;
        (controls as any).fitToBox(targetObj, true, { 
          paddingTop: pad, 
          paddingLeft: pad, 
          paddingBottom: pad, 
          paddingRight: pad 
        });
      }
    }
  });

  // 工具组件，不进行任何真实渲染
  return null;
}

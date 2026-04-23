/**
 * LDrawMeshRenderer.tsx
 * =====================
 * 负责将 GLB 模型克隆并渲染为 ABS 塑料材质的 Three.js 场景图。
 *
 * Hover 检测职责说明：
 *   本组件只负责视觉渲染和高亮/透明度的命令式更新。
 *   InteractivePart 的 hover 状态由上层的 useFrame 逐帧射线检测负责，
 *   此处无需任何 onPointerOver/Out 事件注册。
 *   仅保留 onDoubleClick（用于双击交互）。
 *
 * 高亮/透明度更新：
 *   使用独立 useEffect 命令式更新材质属性，避免 cloned 重建触发任何副作用。
 */

import { useGLTF } from '@react-three/drei';
import { useMemo, useEffect } from 'react';
import * as THREE from 'three';

interface LDrawMeshRendererProps {
  url: string;
  onDoubleClick?: (e: unknown) => void;
  onPointerDown?: (e: unknown) => void;
  highlightColor?: string | null;
  highlightIntensity?: number;
  highlightOutline?: boolean;
  disableRaycast?: boolean;
  opacity?: number;
}

const createABSPlasticMaterial = (
  sourceColor: THREE.Color | string | undefined,
  hasVertexColors = false
): THREE.MeshStandardMaterial => {
  const color = hasVertexColors
    ? new THREE.Color(1, 1, 1)
    : (sourceColor instanceof THREE.Color ? sourceColor : new THREE.Color(sourceColor ?? 0xaaaaaa));

  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.3,
    metalness: 0.0,
    envMapIntensity: 0.8,
    vertexColors: hasVertexColors,
    side: THREE.DoubleSide,
  });
};

export function LDrawMeshRenderer({
  url,
  onDoubleClick,
  onPointerDown,
  highlightColor = null,
  highlightIntensity = 0,
  highlightOutline = false,
  disableRaycast = false,
  opacity = 1.0,
}: LDrawMeshRendererProps) {
  const gltf = useGLTF(url, true) as unknown as { scene: THREE.Group | THREE.Group[] };
  const scene: THREE.Group | null = Array.isArray(gltf.scene) ? gltf.scene[0] : gltf.scene;

  // 仅依赖 scene（GLB 文件）时重建，避免 hover 状态变化触发不必要的重建。
  // 同时计算出完美的纯局部包围盒尺寸（此时完全没有受父级变换影响）
  const { visual, localBoxSize, localBoxCenter } = useMemo(() => {
    if (!scene) return { visual: new THREE.Group(), localBoxSize: new THREE.Vector3(), localBoxCenter: new THREE.Vector3() };
    
    const c = scene.clone(true);
    c.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const hasVC = !!mesh.geometry?.attributes?.color;
        const origColor = (mesh.material as THREE.MeshStandardMaterial)?.color;
        mesh.material = createABSPlasticMaterial(origColor, hasVC);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (disableRaycast) {
          mesh.raycast = () => null;
        }
      }
    });

    // 强制更新矩阵（此时 c 未被挂载到任何组中，matrixWorld 必然为纯净的自身矩阵）
    c.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(c);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    
    return { visual: c, localBoxSize: size, localBoxCenter: center };
  }, [scene, disableRaycast]);

  // 严格底层的垃圾回收：我们在 useMemo 里为 clone 出来的 Mesh 注入了全新的 Material，
  // 必须严格在组件卸载或 visual 重建时显式 dispose Material。
  // 警告：千万不要 dispose geometry！因为 geometry 是由 LDrawLoader 缓存并在所有 clone 间共享的！
  // 随意 dispose shared geometry 会立刻导致严重的 WebGL Context Lost 崩溃！
  useEffect(() => {
    return () => {
      visual.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (mesh.material) {
            if (Array.isArray(mesh.material)) {
              mesh.material.forEach(m => m.dispose());
            } else {
              mesh.material.dispose();
            }
          }
        }
      });
    };
  }, [visual]);

  // 命令式更新高亮 emissive，不触发 visual 重建
  useEffect(() => {
    visual.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (!mat) return;
        mat.emissive = new THREE.Color(highlightColor ?? 0x000000);
        mat.emissiveIntensity = highlightColor ? (highlightIntensity ?? 0) : 0;
        mat.needsUpdate = true;
      }
    });
  }, [visual, highlightColor, highlightIntensity]);

  // 命令式更新透明度，不触发 visual 重建
  useEffect(() => {
    visual.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (!mat) return;
        if (opacity < 1.0) {
          mat.transparent = true;
          mat.opacity = opacity;
          mat.depthWrite = false;
        } else {
          mat.transparent = false;
          mat.opacity = 1.0;
          mat.depthWrite = true;
        }
        mat.needsUpdate = true;
      }
    });
  }, [visual, opacity]);

  // 生成完美跟随的局部包围盒 (Local Bounding Box)
  const boxHelper = useMemo(() => {
    if (!highlightOutline || localBoxSize.length() === 0) return null;
    
    // 根据最初缓存的局部包围盒尺寸创建一个线框几何体
    const boxGeom = new THREE.BoxGeometry(localBoxSize.x, localBoxSize.y, localBoxSize.z);
    const edgesGeom = new THREE.EdgesGeometry(boxGeom);
    const material = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
    
    const lines = new THREE.LineSegments(edgesGeom, material);
    lines.position.copy(localBoxCenter); // 修正到局部质心
    
    // 此局部线框将作为子节点与 visual 同级挂载，完美继承父级的任何平移、旋转
    return lines;
  }, [localBoxSize, localBoxCenter, highlightOutline]);

  return (
    <>
      <primitive
        object={visual}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
      />
      {/* 独立渲染包围盒，与原零件完全解耦 */}
      {boxHelper && <primitive object={boxHelper} />}
    </>
  );
}

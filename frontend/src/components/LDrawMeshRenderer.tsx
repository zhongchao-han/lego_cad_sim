/**
 * LDrawMeshRenderer.tsx
 * =====================
 * 负责将 GLB 模型克隆并渲染为 ABS 塑料材质的 Three.js 场景图。
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
  exactBoundingBox?: { size: [number, number, number]; center: [number, number, number] };
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
  exactBoundingBox,
}: LDrawMeshRendererProps) {
  const gltf = useGLTF(url, true) as unknown as { scene: THREE.Group | THREE.Group[] };
  const scene: THREE.Group | null = Array.isArray(gltf.scene) ? gltf.scene[0] : gltf.scene;

  const visual = useMemo(() => {
    if (!scene) return new THREE.Group();
    
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

    return c;
  }, [scene, disableRaycast]);

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

  // 严格执行 Scheme 1 元数据驱动架构：完全信任后端下发的 exactBoundingBox。
  // 前端仅作为无状态的渲染终点 (Dumb Component)，不再进行任何遍历和顶点计算。
  const boxHelper = useMemo(() => {
    if (!highlightOutline || !exactBoundingBox) return null;
    
    const boxGeom = new THREE.BoxGeometry(exactBoundingBox.size[0], exactBoundingBox.size[1], exactBoundingBox.size[2]);
    const edgesGeom = new THREE.EdgesGeometry(boxGeom);
    const material = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
    
    const lines = new THREE.LineSegments(edgesGeom, material);
    lines.position.set(exactBoundingBox.center[0], exactBoundingBox.center[1], exactBoundingBox.center[2]);
    
    return lines;
  }, [exactBoundingBox, highlightOutline]);

  return (
    <>
      <primitive
        object={visual}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
      />
      {boxHelper && <primitive object={boxHelper} />}
    </>
  );
}

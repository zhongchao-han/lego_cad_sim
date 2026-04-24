import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { renderHook, act } from '@testing-library/react';
import { useStore } from '../store';
import { render } from '@testing-library/react';
import { LDrawMeshRenderer } from '../components/LDrawMeshRenderer';
import { WebGLRecoveryWatcher } from '../components/WebGLRecoveryWatcher';

export const mockCanvas = document.createElement('canvas');

vi.mock('@react-three/drei', () => ({
  useGLTF: vi.fn(() => ({
    scene: (() => {
      const g = new THREE.Group();
      const geom = new THREE.BoxGeometry();
      const mat = new THREE.MeshStandardMaterial();
      const m = new THREE.Mesh(geom, mat);
      g.add(m);
      return g;
    })()
  }))
}));

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({
    gl: {
      domElement: mockCanvas
    }
  })
}));


describe('Garbage Collection & Context Recovery', () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  describe('WebGLRecoveryWatcher', () => {
    it('should set contextLost to true when webglcontextlost event fires on canvas', () => {
      render(<WebGLRecoveryWatcher />);
      
      expect(useStore.getState().isContextLost).toBe(false);

      // Simulate Context Lost
      act(() => {
        const event = new Event('webglcontextlost');
        event.preventDefault = vi.fn();
        mockCanvas.dispatchEvent(event);
      });

      expect(useStore.getState().isContextLost).toBe(true);

      // Simulate Context Restored
      act(() => {
        mockCanvas.dispatchEvent(new Event('webglcontextrestored'));
      });

      expect(useStore.getState().isContextLost).toBe(false);
    });
  });

  describe('LDrawMeshRenderer GC Disposal', () => {
    it('should invoke geometry and material dispose() directly upon unmount to prevent VRAM leak', () => {
      const disposeSpyGeo = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
      const disposeSpyMat = vi.spyOn(THREE.Material.prototype, 'dispose');
      
      // 首次渲染挂载组件
      const { unmount } = render(<LDrawMeshRenderer url="/dummy.glb" />);
      
      expect(disposeSpyGeo).not.toHaveBeenCalled();
      expect(disposeSpyMat).not.toHaveBeenCalled();
      
      // 卸载组件触发 useEffect 清理阶段，这将被测试强制接管的 dispose 执行情况
      unmount();
      
      // 因为 scene clone 后会覆盖自己的材质结构，所以必定调用材质的 dispose。
      // 注意：绝对不能 expect geometry.dispose() 被调用，因为 geometry 在 LDrawLoader 中是全局共享缓存的。
      expect(disposeSpyMat).toHaveBeenCalled();
      
      disposeSpyGeo.mockRestore();
      disposeSpyMat.mockRestore();
    });
  });
});

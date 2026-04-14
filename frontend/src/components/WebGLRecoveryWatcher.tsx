import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useStore } from '../store';

export function WebGLRecoveryWatcher() {
  const { gl } = useThree();
  const setContextLost = useStore(state => state.setContextLost);

  useEffect(() => {
    const canvas = gl.domElement;

    const handleContextLost = (event: Event) => {
      // 必须调用 preventDefault，这样浏览器才有可能尝试恢复上下文
      event.preventDefault();
      setContextLost(true);
      console.error("[WebGLRecoveryWatcher] WebGL Context Lost! Geometry buffers are dumped by the GPU.");
    };

    const handleContextRestored = () => {
      setContextLost(false);
      console.warn("[WebGLRecoveryWatcher] WebGL Context Restored! Re-initializing textures.");
      // 实际上我们由于之前丢弃了 Context，组件树可能需要被重新装载来重新渲染 buffer。
      // 在当前框架下，只要 isContextLost 恢复为 false，R3F 本身能尝试恢复剩余存活的内容。
    };

    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

    return () => {
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
    };
  }, [gl, setContextLost]);

  return null;
}

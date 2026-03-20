import React, { useEffect, useRef } from 'react';
import { CameraControls } from '@react-three/drei';

/**
 * 通用相机控制器组件 (CameraController)
 * 职责：
 * 1. 管理 CameraControls 的生命周期与基础配置 (min/max distance, dollyToCursor)。
 * 2. 响应式对焦：当 target 属性变化时，自动执行平滑对焦动画。
 * 遵循单一责任原则：只负责执行“摄像机到哪儿去”，不关心“谁选中了什么”。
 */

interface CameraControllerProps {
  /** 对焦点目标坐标：[x, y, z] 或 null (不执行动作) */
  target: [number, number, number] | null;
  /** 最小缩放距离 */
  minDistance?: number;
  /** 最大缩放距离 */
  maxDistance?: number;
  /** 鼠标按键映射 */
  mouseButtons?: any;
}

export const CameraController: React.FC<CameraControllerProps> = ({ 
  target, 
  minDistance = 0.001, 
  maxDistance = 1,
  mouseButtons = { left: 1, middle: 0, right: 2, wheel: 8 }
}) => {
  const controlsRef = useRef<CameraControls>(null);

  // 核心聚焦动效
  useEffect(() => {
    if (controlsRef.current && target) {
      // 第四个参数 true 表示开启平滑过渡动画
      controlsRef.current.setTarget(target[0], target[1], target[2], true);
    }
  }, [target]);

  return (
    <CameraControls 
      ref={controlsRef} 
      makeDefault 
      minDistance={minDistance} 
      maxDistance={maxDistance}
      dollyToCursor={true} // 保持人性化的基于指针缩放
      mouseButtons={mouseButtons}
    />
  );
};

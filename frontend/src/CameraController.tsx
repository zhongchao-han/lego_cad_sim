import React, { useEffect, useRef } from 'react';
import { CameraControls } from '@react-three/drei';
import { registerCameraGroundAxesProvider } from './utils/cameraGroundAxes';

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
  minDistance = 0.0001, 
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

  // 把相机地面方向暴露给键盘 dispatcher（方向键平移跟随视角，见 cameraGroundAxes.ts）。
  // 惰性读 matrixWorld：按键时才算，零 per-frame 开销。
  useEffect(() => {
    registerCameraGroundAxesProvider(() => {
      const cam = controlsRef.current?.camera;
      if (!cam) return null;
      const e = cam.matrixWorld.elements;
      // 相机 local +X（屏幕右）投影到地面。无 roll 的轨道相机里它恒为水平，即便俯视也稳定。
      let rx = e[0], rz = e[2];
      const rlen = Math.hypot(rx, rz);
      if (rlen < 1e-6) return null;
      rx /= rlen; rz /= rlen;
      // 视线方向（local -Z）投影 = 屏幕「前/深处」。
      let fx = -e[8], fz = -e[10];
      let flen = Math.hypot(fx, fz);
      if (flen < 1e-6) {
        // 正俯视时视线≈竖直、投影退化 → 用相机 local +Y（屏幕上方）投影兜底。
        fx = e[4]; fz = e[6];
        flen = Math.hypot(fx, fz);
        if (flen < 1e-6) return null;
      }
      fx /= flen; fz /= flen;
      // 视线方向(世界系,单位向量)=相机 local -Z：col2=(e[8],e[9],e[10]) 是 local +Z，
      // 视线 = -localZ。供旋转绕「最接近视线的世界轴」用。
      const viewDir: [number, number, number] = [-e[8], -e[9], -e[10]];
      return { right: [rx, rz], forward: [fx, fz], viewDir };
    });
    return () => registerCameraGroundAxesProvider(null);
  }, []);

  return (
      <CameraControls 
      ref={controlsRef} 
      makeDefault 
      minDistance={minDistance} 
      maxDistance={maxDistance}
      dollyToCursor={true} // 保持人性化的基于指针缩放
      infinityDolly={true} // 消除逼近 target 时的对数减速限制，允许无限深潜缩放
      mouseButtons={mouseButtons}
      dollySpeed={5}           // 再次加倍缩放速度
      azimuthRotateSpeed={1.5} // 加快水平旋转速度
      polarRotateSpeed={1.5}   // 加快垂直旋转速度
      smoothTime={0.25}        // 增加镜头阻尼感，提升操控顺滑度
    />
  );
};

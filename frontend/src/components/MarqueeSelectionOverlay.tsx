import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useStore } from '../store';
import * as THREE from 'three';
import { ZoneType } from '../types';

/**
 * MarqueeSelectionOverlay —— Canvas 内的框选 **控制器**（只跑逻辑，不渲染 DOM）。
 *
 * ⚠️ 历史 bug：本组件曾在 R3F 树里 `createPortal(<div>)` 渲染框选矩形 —— R3F 的
 * reconciler 只认 THREE 对象，遇到 <div> 抛 "Div is not part of the THREE
 * namespace" 并使 Canvas Context Lost（shift+拖拽必崩）。
 *
 * 修法：矩形改由 Canvas **外**的 <MarqueeBox/> 渲染（普通 HTML overlay）。本组件
 * 只负责：监听 shift+拖拽、把矩形像素写进 store.marqueeBox（供 MarqueeBox 渲染）、
 * 抬起时用 camera 投影把落在框里的零件 setMarqueeSelection。返回 null（不进 R3F 树）。
 */
export function MarqueeSelectionOverlay() {
  const { camera, gl } = useThree();
  // makeDefault 的 CameraControls 实例（见 CameraController）。框选拖拽时临时禁用，
  // 否则同一次 shift+拖拽会被相机控制器当成旋转手势 → 边框选边转视角。
  const controls = useThree(s => s.controls as unknown as { enabled?: boolean } | null);
  const setMarqueeSelection = useStore(state => state.setMarqueeSelection);
  const setMarqueeBox = useStore(state => state.setMarqueeBox);

  useEffect(() => {
    const canvas = gl.domElement;
    let isDrawing = false;
    let startPoint = { x: 0, y: 0 };

    const setControlsEnabled = (on: boolean) => { if (controls) controls.enabled = on; };

    const writeBox = (curX: number, curY: number) => {
      setMarqueeBox({
        left: Math.min(startPoint.x, curX),
        top: Math.min(startPoint.y, curY),
        width: Math.abs(curX - startPoint.x),
        height: Math.abs(curY - startPoint.y),
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      // 仅 Shift + 左键拖拽才进框选（否则交给相机控制器 / 普通点击）。
      if (!e.shiftKey || e.button !== 0) return;
      isDrawing = true;
      startPoint = { x: e.clientX, y: e.clientY };
      setControlsEnabled(false); // 禁用相机旋转，避免框选时画面跟着转
      writeBox(e.clientX, e.clientY);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDrawing) return;
      writeBox(e.clientX, e.clientY);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDrawing) return;
      isDrawing = false;
      setMarqueeBox(null);
      setControlsEnabled(true); // 恢复相机控制（务必在任何 early-return 之前）

      const width = document.body.clientWidth;
      const height = document.body.clientHeight;
      const minX = Math.min(startPoint.x, e.clientX);
      const maxX = Math.max(startPoint.x, e.clientX);
      const minY = Math.min(startPoint.y, e.clientY);
      const maxY = Math.max(startPoint.y, e.clientY);

      // 拖拽太小判为误触（点击），不框选。
      if (maxX - minX < 5 && maxY - minY < 5) return;

      const ids: string[] = [];
      const tempVec = new THREE.Vector3();
      const tempQuat = new THREE.Quaternion();
      const st = useStore.getState();
      Object.entries(st.parts).forEach(([id, state]) => {
        if (state.zone !== ZoneType.ACTIVE_ARENA || st.hiddenParts.has(id)) return;
        // 用「世界包围盒中心」而非零件原点做命中：原点常偏离可见网格（大底板原点在角、
        // 板/销原点偏置），用原点会框中"看不见的"件、漏掉真正框住的件 → 选中数与视觉不符。
        // 世界中心 = position + quat·bboxCenterLocal（无 bboxCenter 时退化为原点）。
        const bc = st.partCatalog[state.ldrawId]?.bboxCenter;
        if (bc) {
          tempVec.set(bc[0], bc[1], bc[2]).applyQuaternion(
            tempQuat.set(state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]),
          );
          tempVec.set(tempVec.x + state.position[0], tempVec.y + state.position[1], tempVec.z + state.position[2]);
        } else {
          tempVec.set(state.position[0], state.position[1], state.position[2]);
        }
        tempVec.project(camera); // 3D → NDC [-1,1]
        const screenX = (tempVec.x * 0.5 + 0.5) * width;
        const screenY = (-(tempVec.y * 0.5) + 0.5) * height;
        if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) {
          ids.push(id);
        }
      });
      setMarqueeSelection(ids);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    // move/up 绑到 window，框拖出 canvas 也能跟踪 + 收尾。
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setMarqueeBox(null);
      setControlsEnabled(true); // 卸载时恢复相机控制，防卡在禁用态
    };
  }, [camera, gl.domElement, controls, setMarqueeSelection, setMarqueeBox]);

  // 不在 R3F 树里渲染任何 DOM —— 矩形交给 Canvas 外的 <MarqueeBox/>。
  return null;
}

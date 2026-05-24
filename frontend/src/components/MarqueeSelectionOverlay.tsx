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
  const setMarqueeSelection = useStore(state => state.setMarqueeSelection);
  const setMarqueeBox = useStore(state => state.setMarqueeBox);

  useEffect(() => {
    const canvas = gl.domElement;
    let isDrawing = false;
    let startPoint = { x: 0, y: 0 };

    const writeBox = (curX: number, curY: number) => {
      setMarqueeBox({
        left: Math.min(startPoint.x, curX),
        top: Math.min(startPoint.y, curY),
        width: Math.abs(curX - startPoint.x),
        height: Math.abs(curY - startPoint.y),
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      // 仅 Shift + 左键拖拽才进框选（否则交给 OrbitControls / 普通点击）。
      if (!e.shiftKey || e.button !== 0) return;
      isDrawing = true;
      startPoint = { x: e.clientX, y: e.clientY };
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
      const st = useStore.getState();
      Object.entries(st.parts).forEach(([id, state]) => {
        if (state.zone !== ZoneType.ACTIVE_ARENA || st.hiddenParts.has(id)) return;
        tempVec.set(state.position[0], state.position[1], state.position[2]);
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
    };
  }, [camera, gl.domElement, setMarqueeSelection, setMarqueeBox]);

  // 不在 R3F 树里渲染任何 DOM —— 矩形交给 Canvas 外的 <MarqueeBox/>。
  return null;
}

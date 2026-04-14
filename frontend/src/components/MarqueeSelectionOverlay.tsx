import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useThree } from '@react-three/fiber';
import { useStore } from '../store';
import * as THREE from 'three';
import { ZoneType } from '../types';

export function MarqueeSelectionOverlay() {
  const { camera, gl } = useThree();
  const [box, setBox] = useState<{ startX: number, startY: number, currentX: number, currentY: number } | null>(null);
  const setMarqueeSelection = useStore(state => state.setMarqueeSelection);

  useEffect(() => {
    const canvas = gl.domElement;
    let isDrawing = false;
    let startPoint = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      // Hanya menginterupsi jika Shift ditarik
      if (!e.shiftKey || e.button !== 0) return;
      isDrawing = true;
      startPoint = { x: e.clientX, y: e.clientY };
      setBox({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY });
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDrawing) return;
      setBox({ startX: startPoint.x, startY: startPoint.y, currentX: e.clientX, currentY: e.clientY });
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDrawing) return;
      isDrawing = false;
      
      const width = document.body.clientWidth;
      const height = document.body.clientHeight;

      // Extract Screen Bounds
      const minX = Math.min(startPoint.x, e.clientX);
      const maxX = Math.max(startPoint.x, e.clientX);
      const minY = Math.min(startPoint.y, e.clientY);
      const maxY = Math.max(startPoint.y, e.clientY);

      setBox(null);

      // Guard against click vs drag
      if (maxX - minX < 5 && maxY - minY < 5) return;

      const ids: string[] = [];
      const tempVec = new THREE.Vector3();
      const st = useStore.getState();
      
      Object.entries(st.parts).forEach(([id, state]) => {
         if (state.zone !== ZoneType.ACTIVE_ARENA || st.hiddenParts.has(id)) return;
         
         tempVec.set(state.position[0], state.position[1], state.position[2]);
         
         // 3D Point to Normal Device Coordinate Projection [-1, 1]
         tempVec.project(camera);
         
         // NDC to Screen Space X / Y
         const screenX = (tempVec.x * 0.5 + 0.5) * width;
         const screenY = (-(tempVec.y * 0.5) + 0.5) * height;

         if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) {
             ids.push(id);
         }
      });

      setMarqueeSelection(ids);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    // Bind move and up to window so they catch outside canvas exits
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [camera, gl.domElement, setMarqueeSelection]);

  if (!box) return null;

  const left = Math.min(box.startX, box.currentX);
  const top = Math.min(box.startY, box.currentY);
  const w = Math.abs(box.currentX - box.startX);
  const h = Math.abs(box.currentY - box.startY);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left,
        top,
        width: w,
        height: h,
        backgroundColor: 'rgba(56, 189, 248, 0.2)',
        border: '1px solid rgba(56, 189, 248, 0.8)',
        pointerEvents: 'none',
        zIndex: 99999,
      }}
    />,
    document.body
  );
}

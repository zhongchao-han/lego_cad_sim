import { useRef } from 'react';
import * as THREE from 'three';
import { InteractivePart } from './InteractivePart';
import { AutoFitCamera } from './AutoFitCamera';
import { isTurntableAssemblyTop, turntableBaseFor } from '../utils/turntableAssembly';
import type { SelectedPortInfo } from '../types';

/**
 * PreviewModel.tsx
 * ================
 * 预览面（hover 浮窗 / Assign Source Port）里的 3D 模型渲染。
 *
 * 普通件：单个 InteractivePart，沿用其内置 autoCenter。
 * 「整体转盘」：渲染顶 + 底两半，二者同放局部原点（与 store.startFreePlacingTurntable
 *   的落地姿态一致：position[0,0,0]、单位四元数 → 同轴装配态），相机对焦两半合并包围盒。
 *   底座只读展示（无事件/端口），端口交互仍只挂在顶上——整体落地由上层 onPortClick 分流。
 */
interface PreviewModelProps {
  partId: string;
  colorCode: number;
  isStatic?: boolean;
  disableEvents?: boolean;
  opacity?: number;
  showPorts?: boolean;
  onPortClick?: (port: SelectedPortInfo) => void;
}

export function PreviewModel({
  partId,
  colorCode,
  isStatic,
  disableEvents,
  opacity,
  showPorts,
  onPortClick,
}: PreviewModelProps) {
  const groupRef = useRef<THREE.Group>(null);
  const base = isTurntableAssemblyTop(partId) ? turntableBaseFor(partId) : null;

  if (!base) {
    return (
      <InteractivePart
        partId={partId}
        colorCode={colorCode}
        isStatic={isStatic}
        disableEvents={disableEvents}
        opacity={opacity}
        showPorts={showPorts}
        onPortClick={onPortClick}
        autoCenter
      />
    );
  }

  return (
    <>
      <group ref={groupRef}>
        <InteractivePart
          partId={partId}
          colorCode={colorCode}
          isStatic={isStatic}
          disableEvents={disableEvents}
          opacity={opacity}
          showPorts={showPorts}
          onPortClick={onPortClick}
          autoCenter={false}
        />
        <InteractivePart
          partId={base}
          colorCode={colorCode}
          isStatic
          disableEvents
          opacity={opacity}
          showPorts={false}
          autoCenter={false}
        />
      </group>
      <AutoFitCamera targetRef={groupRef} />
    </>
  );
}

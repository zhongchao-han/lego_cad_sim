import { Suspense, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useFrame } from '@react-three/fiber';
import { CameraControls, Html } from '@react-three/drei';
import { InteractivePart } from './InteractivePart';
import { getDefaultColorCode } from '../utils/partColorDefaults';
import type { HoverPreviewState } from '../hooks/useHoverPreview';

const SIZE = 240;          // 浮窗 3D 视口边长 (px)
const GAP = 12;            // 浮窗与缩略图之间的间隙 (px)
const MARGIN = 8;          // 距视口边缘的最小留白 (px)
const SPIN_SPEED = 0.7;    // 自动旋转角速度 (rad/s)

/** 持续绕零件中心做方位角自转。fitToBox(AutoFitCamera) 已把 orbit target
 *  设为包围盒中心，故这里只需每帧推进 azimuth 即得「原地转圈」效果。 */
function AutoOrbit() {
  useFrame((state, delta) => {
    const c = state.controls as { rotate?: (a: number, p: number, t: boolean) => void } | null;
    if (c && typeof c.rotate === 'function') {
      c.rotate(delta * SPIN_SPEED, 0, false);
    }
  });
  return null;
}

/** 浮窗水平定位：把浮窗摆到**所属面板边界外侧**，避免盖住列表/结果本身。
 *  - 左栏（贴屏幕左）：放面板右缘外，浮在 3D 场景上。
 *  - 居中搜索弹窗：放弹窗外侧（右侧空白遮罩区）。
 *  优先右侧外放不下→退左侧外→都放不下才贴缩略图右侧兜底。无 boundary（理论
 *  上不会发生）时退回以缩略图为基准。最终统一夹紧视口。 */
function computeLeft(rect: DOMRect, boundary: DOMRect | null): number {
  let left: number;
  if (boundary) {
    const rightOuter = boundary.right + GAP;
    const leftOuter = boundary.left - SIZE - GAP;
    if (rightOuter + SIZE + MARGIN <= window.innerWidth) left = rightOuter;
    else if (leftOuter >= MARGIN) left = leftOuter;
    else left = rect.right + GAP;
  } else {
    const fitsLeft = rect.left >= SIZE + GAP + MARGIN;
    left = fitsLeft ? rect.left - SIZE - GAP : rect.right + GAP;
  }
  return Math.max(MARGIN, Math.min(left, window.innerWidth - SIZE - MARGIN));
}

function computePosition(rect: DOMRect, boundary: DOMRect | null): { left: number; top: number } {
  const left = computeLeft(rect, boundary);
  const rawTop = rect.top + rect.height / 2 - SIZE / 2;
  const top = Math.max(MARGIN, Math.min(rawTop, window.innerHeight - SIZE - MARGIN));
  return { left, top };
}

/**
 * PartHoverPreview.tsx
 * ====================
 * hover 缩略图时的 3D 预览浮窗：自动对焦 + 自动旋转，纯展示（pointer-events:none，
 * 不参与拾取，避免遮挡列表交互）。partId 统一补 `.dat` 后缀以对齐 ldraw_part API。
 */
export function PartHoverPreview({ preview }: { preview: HoverPreviewState }) {
  const { partId, rect, boundaryRect } = preview;

  const normalizedId = useMemo(
    () => (partId ? (partId.endsWith('.dat') ? partId : `${partId}.dat`) : null),
    [partId],
  );
  const colorCode = useMemo(
    () => (normalizedId ? getDefaultColorCode(normalizedId, 71) : 71),
    [normalizedId],
  );

  if (!normalizedId || !rect) return null;

  const { left, top } = computePosition(rect, boundaryRect);

  // 经 body 级 Portal 渲染：面板根节点的 backdrop-filter 会让 position:fixed
  // 改为相对面板定位，叠加面板的 overflow-hidden 会把摆到面板外的浮窗裁掉。
  // 挂到 body 脱离该子树，fixed 才真正相对视口、不被裁剪。
  return createPortal(
    <div
      className="fixed z-[300] pointer-events-none rounded-xl shadow-2xl ring-1 ring-black/10 overflow-hidden bg-white"
      style={{ left, top, width: SIZE, height: SIZE }}
    >
      <Canvas
        camera={{ position: [0.05, 0.05, 0.05], fov: 35, near: 0.001, far: 50 }}
        className="w-full h-full"
        style={{ background: '#f1f5f9' }}
      >
        <Suspense
          fallback={
            <Html center>
              <div className="animate-pulse text-[11px] text-slate-400 whitespace-nowrap">加载模型…</div>
            </Html>
          }
        >
          <ambientLight intensity={0.7} />
          <directionalLight position={[1, 2, 3]} intensity={1.5} />
          <directionalLight position={[-2, 1, -1]} intensity={0.6} />

          <InteractivePart
            partId={normalizedId}
            colorCode={colorCode}
            disableEvents
            autoCenter
            showPorts={false}
          />

          <CameraControls makeDefault minDistance={0.001} maxDistance={5.0} smoothTime={0.25} />
          <AutoOrbit />
        </Suspense>
      </Canvas>
    </div>,
    document.body,
  );
}

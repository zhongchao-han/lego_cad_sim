import { useStore } from '../store';

/**
 * MarqueeBox —— Canvas **外**的框选矩形（普通 HTML overlay）。
 *
 * 与 MarqueeSelectionOverlay（Canvas 内控制器）配对：控制器把矩形像素写进
 * store.marqueeBox，这里据此渲染半透明蓝框。放在 Canvas 外避免 R3F reconciler
 * 处理 <div> 崩溃（见 MarqueeSelectionOverlay 注释）。
 */
export function MarqueeBox() {
  const box = useStore(s => s.marqueeBox);
  if (!box) return null;
  return (
    <div
      data-testid="marquee-box"
      style={{
        position: 'fixed',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        backgroundColor: 'rgba(56, 189, 248, 0.2)',
        border: '1px solid rgba(56, 189, 248, 0.8)',
        pointerEvents: 'none',
        zIndex: 99999,
      }}
    />
  );
}

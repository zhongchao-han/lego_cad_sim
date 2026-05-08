/**
 * useHoverDebounce.test.tsx
 * =========================
 * 第四阶段长尾 — useHoverDebounce 50ms over→out 防抖,审计闭环。
 *
 * setHoveredPort 是 store 层 300ms 全局防抖（issue #61 修后单 dispatcher）；
 * useHoverDebounce 是组件层局部防抖（默认 50ms），用在 InteractivePart /
 * SiteGizmo 等高频 R3F pointerOver/Out 抖动场景。两者互补,本组用 vi.useFakeTimers
 * 控制 setTimeout。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHoverDebounce } from '../hooks/useHoverDebounce';

describe('useHoverDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('case 1: 初始 hovered=false', () => {
    const { result } = renderHook(() => useHoverDebounce());
    expect(result.current.hovered).toBe(false);
  });

  it('case 2: onPointerOver 立即 hovered=true', () => {
    const { result } = renderHook(() => useHoverDebounce());
    act(() => result.current.onPointerOver());
    expect(result.current.hovered).toBe(true);
  });

  it('case 3: onPointerOut 不立即清，50ms 后清', () => {
    const { result } = renderHook(() => useHoverDebounce());
    act(() => result.current.onPointerOver());
    act(() => result.current.onPointerOut());
    // 立即查仍 true
    expect(result.current.hovered).toBe(true);
    // 49ms 仍 true
    act(() => { vi.advanceTimersByTime(49); });
    expect(result.current.hovered).toBe(true);
    // 51ms 清空
    act(() => { vi.advanceTimersByTime(2); });
    expect(result.current.hovered).toBe(false);
  });

  it('case 4: out 后 50ms 内 over → 取消 timer，hovered 保持 true', () => {
    const { result } = renderHook(() => useHoverDebounce());
    act(() => result.current.onPointerOver());
    act(() => result.current.onPointerOut()); // 启 timer
    act(() => { vi.advanceTimersByTime(20); });
    act(() => result.current.onPointerOver()); // 取消 timer
    // 推 100ms,旧 timer 不应触发
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.hovered).toBe(true);
  });

  it('case 5: 自定义 delayMs=200', () => {
    const { result } = renderHook(() => useHoverDebounce(200));
    act(() => result.current.onPointerOver());
    act(() => result.current.onPointerOut());
    // 100ms 仍 true（< 200ms 阈值）
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.hovered).toBe(true);
    // 201ms 清空
    act(() => { vi.advanceTimersByTime(101); });
    expect(result.current.hovered).toBe(false);
  });

  it('case 6: 连续 out → out → out 只计最后一次（重置 timer）', () => {
    const { result } = renderHook(() => useHoverDebounce(50));
    act(() => result.current.onPointerOver());
    act(() => result.current.onPointerOut());
    act(() => { vi.advanceTimersByTime(30); });
    act(() => result.current.onPointerOut()); // 重置 timer
    act(() => { vi.advanceTimersByTime(30); });
    // 第一次 timer 已被取消;第二次重新计时,30ms 还没到 50ms
    expect(result.current.hovered).toBe(true);
    act(() => { vi.advanceTimersByTime(25); });
    expect(result.current.hovered).toBe(false);
  });

  it('case 7: unmount 后 timer 被清,不再触发 setHovered', () => {
    const { result, unmount } = renderHook(() => useHoverDebounce());
    act(() => result.current.onPointerOver());
    act(() => result.current.onPointerOut());
    unmount();
    // 推 100ms,timer 应已被 useEffect cleanup 清掉,不抛 React state update on unmounted
    act(() => { vi.advanceTimersByTime(100); });
    // 没法直接验 hovered（unmount 后 result.current 不变化）
    // 但只要这段不抛 act-warning 即说明 cleanup 成功
  });
});

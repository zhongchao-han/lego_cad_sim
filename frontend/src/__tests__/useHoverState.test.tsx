import { renderHook, act } from '@testing-library/react';
import { useHoverState } from '../hooks/useHoverState';

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({
    mouse: {},
    camera: {}
  }),
}));

describe('useHoverState Hook', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should handle instant hover IN', () => {
    const onHoverChange = vi.fn();
    const addLog = vi.fn();
    const { result } = renderHook(() => useHoverState({
      partId: '1', ldrawId: 'part1', disableEvents: false, isStatic: false, onHoverChange, addLog, groupRef: { current: null }
    }));

    act(() => {
      result.current.handlePointerOver?.({ stopPropagation: vi.fn() });
    });

    expect(result.current.hovered).toBe(true);
    expect(onHoverChange).toHaveBeenCalledWith(true);
    expect(addLog).toHaveBeenCalledWith(expect.stringContaining('Hover IN'), 'INFO');
  });

  it('should debounce hover OUT by 80ms', () => {
    const onHoverChange = vi.fn();
    const addLog = vi.fn();
    const { result } = renderHook(() => useHoverState({
      partId: '1', ldrawId: 'part1', disableEvents: false, isStatic: false, onHoverChange, addLog, groupRef: { current: null }
    }));

    act(() => {
      result.current.handlePointerOver?.({ stopPropagation: vi.fn() });
    });

    expect(result.current.hovered).toBe(true);
    onHoverChange.mockClear();

    act(() => {
      result.current.handlePointerOut?.();
    });

    // Should still be hovered immediately after pointerOut
    expect(result.current.hovered).toBe(true);
    expect(onHoverChange).not.toHaveBeenCalled();

    // Advance time by 50ms
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.hovered).toBe(true);

    // Advance time to pass the 80ms threshold
    act(() => {
      vi.advanceTimersByTime(35);
    });

    expect(result.current.hovered).toBe(false);
    expect(onHoverChange).toHaveBeenCalledWith(false);
  });

  it('should cancel hover OUT if pointer enters again within 80ms', () => {
    const onHoverChange = vi.fn();
    const addLog = vi.fn();
    const { result } = renderHook(() => useHoverState({
      partId: '1', ldrawId: 'part1', disableEvents: false, isStatic: false, onHoverChange, addLog, groupRef: { current: null }
    }));

    act(() => {
      result.current.handlePointerOver?.({ stopPropagation: vi.fn() });
    });
    expect(result.current.hovered).toBe(true);
    
    act(() => {
      result.current.handlePointerOut?.();
    });

    // Before 80ms, mouse comes back
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(result.current.hovered).toBe(true);

    act(() => {
      result.current.handlePointerOver?.({ stopPropagation: vi.fn() });
    });

    // Advance past original 80ms timer
    act(() => {
      vi.advanceTimersByTime(50);
    });

    // Should still be hovered!
    expect(result.current.hovered).toBe(true);
    // Should NOT have called onHoverChange(false)
    expect(onHoverChange).not.toHaveBeenCalledWith(false);
  });
});

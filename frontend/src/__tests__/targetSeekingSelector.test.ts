import { renderHook } from '@testing-library/react';
import { useStore, useIsTargetSeekingPhase } from '../store';
import { InteractionPhase } from '../types';

describe('useIsTargetSeekingPhase Selector', () => {
  beforeEach(() => {
    useStore.setState({ interactionPhase: InteractionPhase.IDLE } as any);
  });

  it('should return false when in IDLE phase', () => {
    const { result } = renderHook(() => useIsTargetSeekingPhase());
    expect(result.current).toBe(false);
  });

  it('should return false when in PREVIEWING phase', () => {
    useStore.setState({ interactionPhase: InteractionPhase.PREVIEWING } as any);
    const { result } = renderHook(() => useIsTargetSeekingPhase());
    expect(result.current).toBe(false);
  });

  it('should return true when in SOURCE_LOCKED phase', () => {
    useStore.setState({ interactionPhase: InteractionPhase.SOURCE_LOCKED } as any);
    const { result } = renderHook(() => useIsTargetSeekingPhase());
    expect(result.current).toBe(true);
  });

  it('should return false when in AXIAL_SLIDING phase', () => {
    useStore.setState({ interactionPhase: InteractionPhase.AXIAL_SLIDING } as any);
    const { result } = renderHook(() => useIsTargetSeekingPhase());
    expect(result.current).toBe(false);
  });

  it('should return false when in FREE_PLACING phase', () => {
    useStore.setState({ interactionPhase: InteractionPhase.FREE_PLACING } as any);
    const { result } = renderHook(() => useIsTargetSeekingPhase());
    expect(result.current).toBe(false);
  });
});

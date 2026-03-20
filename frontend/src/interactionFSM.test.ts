/**
 * interactionFSM.test.ts
 * =======================
 * InteractionPhase 状态机的单元测试。
 */

import { describe, it, expect } from 'vitest';
import {
  InteractionPhase,
  isValidTransition,
  transition,
  InteractionEvents,
} from './interactionFSM';

// ---------------------------------------------------------------------------
// isValidTransition
// ---------------------------------------------------------------------------

describe('isValidTransition', () => {
  it('IDLE → PICKING_FROM_LIBRARY is valid', () => {
    expect(isValidTransition(InteractionPhase.IDLE, InteractionPhase.PICKING_FROM_LIBRARY)).toBe(true);
  });

  it('PICKING_FROM_LIBRARY → SOURCE_LOCKED is valid', () => {
    expect(isValidTransition(InteractionPhase.PICKING_FROM_LIBRARY, InteractionPhase.SOURCE_LOCKED)).toBe(true);
  });

  it('PICKING_FROM_LIBRARY → IDLE is valid', () => {
    expect(isValidTransition(InteractionPhase.PICKING_FROM_LIBRARY, InteractionPhase.IDLE)).toBe(true);
  });

  it('IDLE → SOURCE_LOCKED is valid', () => {
    expect(isValidTransition(InteractionPhase.IDLE, InteractionPhase.SOURCE_LOCKED)).toBe(true);
  });

  it('IDLE → ANIMATING_SNAP is NOT valid', () => {
    expect(isValidTransition(InteractionPhase.IDLE, InteractionPhase.ANIMATING_SNAP)).toBe(false);
  });

  it('IDLE → IDLE is NOT valid', () => {
    expect(isValidTransition(InteractionPhase.IDLE, InteractionPhase.IDLE)).toBe(false);
  });

  it('SOURCE_LOCKED → IDLE is valid (cancel)', () => {
    expect(isValidTransition(InteractionPhase.SOURCE_LOCKED, InteractionPhase.IDLE)).toBe(true);
  });

  it('SOURCE_LOCKED → ANIMATING_SNAP is valid', () => {
    expect(isValidTransition(InteractionPhase.SOURCE_LOCKED, InteractionPhase.ANIMATING_SNAP)).toBe(true);
  });

  it('SOURCE_LOCKED → SOURCE_LOCKED is NOT valid', () => {
    expect(isValidTransition(InteractionPhase.SOURCE_LOCKED, InteractionPhase.SOURCE_LOCKED)).toBe(false);
  });

  it('ANIMATING_SNAP → IDLE is valid (complete)', () => {
    expect(isValidTransition(InteractionPhase.ANIMATING_SNAP, InteractionPhase.IDLE)).toBe(true);
  });

  it('ANIMATING_SNAP → SOURCE_LOCKED is NOT valid', () => {
    expect(isValidTransition(InteractionPhase.ANIMATING_SNAP, InteractionPhase.SOURCE_LOCKED)).toBe(false);
  });

  it('ANIMATING_SNAP → ANIMATING_SNAP is NOT valid', () => {
    expect(isValidTransition(InteractionPhase.ANIMATING_SNAP, InteractionPhase.ANIMATING_SNAP)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

describe('transition', () => {
  it('returns target phase on valid transition', () => {
    expect(transition(InteractionPhase.IDLE, InteractionPhase.SOURCE_LOCKED))
      .toBe(InteractionPhase.SOURCE_LOCKED);
  });

  it('throws on invalid transition', () => {
    expect(() => transition(InteractionPhase.IDLE, InteractionPhase.ANIMATING_SNAP))
      .toThrow('[InteractionFSM]');
  });

  it('throws with descriptive message including from and to phases', () => {
    expect(() => transition(InteractionPhase.ANIMATING_SNAP, InteractionPhase.SOURCE_LOCKED))
      .toThrow('ANIMATING_SNAP');
  });
});

// ---------------------------------------------------------------------------
// InteractionEvents
// ---------------------------------------------------------------------------

describe('InteractionEvents', () => {
  it('pickFromLibrary: IDLE → PICKING_FROM_LIBRARY', () => {
    expect(InteractionEvents.pickFromLibrary(InteractionPhase.IDLE))
      .toBe(InteractionPhase.PICKING_FROM_LIBRARY);
  });

  it('pickSourcePort: PICKING_FROM_LIBRARY → SOURCE_LOCKED', () => {
    expect(InteractionEvents.pickSourcePort(InteractionPhase.PICKING_FROM_LIBRARY))
      .toBe(InteractionPhase.SOURCE_LOCKED);
  });

  it('lockSource: IDLE → SOURCE_LOCKED', () => {
    expect(InteractionEvents.lockSource(InteractionPhase.IDLE))
      .toBe(InteractionPhase.SOURCE_LOCKED);
  });

  it('lockSource: SOURCE_LOCKED → throws (already locked)', () => {
    expect(() => InteractionEvents.lockSource(InteractionPhase.SOURCE_LOCKED))
      .toThrow();
  });

  it('cancel: SOURCE_LOCKED → IDLE', () => {
    expect(InteractionEvents.cancel(InteractionPhase.SOURCE_LOCKED))
      .toBe(InteractionPhase.IDLE);
  });

  it('cancel: IDLE → throws', () => {
    expect(() => InteractionEvents.cancel(InteractionPhase.IDLE)).toThrow();
  });

  it('beginSnap: SOURCE_LOCKED → ANIMATING_SNAP', () => {
    expect(InteractionEvents.beginSnap(InteractionPhase.SOURCE_LOCKED))
      .toBe(InteractionPhase.ANIMATING_SNAP);
  });

  it('beginSnap: IDLE → throws', () => {
    expect(() => InteractionEvents.beginSnap(InteractionPhase.IDLE)).toThrow();
  });

  it('completeSnap: ANIMATING_SNAP → IDLE', () => {
    expect(InteractionEvents.completeSnap(InteractionPhase.ANIMATING_SNAP))
      .toBe(InteractionPhase.IDLE);
  });

  it('completeSnap: SOURCE_LOCKED → IDLE (also valid — cancel shares the same IDLE target)', () => {
    // SOURCE_LOCKED → IDLE is a valid transition (shared with cancel).
    // completeSnap does not need to throw here; callers should gate on phase === ANIMATING_SNAP.
    expect(InteractionEvents.completeSnap(InteractionPhase.SOURCE_LOCKED))
      .toBe(InteractionPhase.IDLE);
  });

  it('full library-to-snap flow: IDLE → PICKING → LOCKED → ANIMATING → IDLE', () => {
    let phase = InteractionPhase.IDLE;
    phase = InteractionEvents.pickFromLibrary(phase);
    expect(phase).toBe(InteractionPhase.PICKING_FROM_LIBRARY);
    phase = InteractionEvents.pickSourcePort(phase);
    expect(phase).toBe(InteractionPhase.SOURCE_LOCKED);
    phase = InteractionEvents.beginSnap(phase);
    expect(phase).toBe(InteractionPhase.ANIMATING_SNAP);
    phase = InteractionEvents.completeSnap(phase);
    expect(phase).toBe(InteractionPhase.IDLE);
  });

  it('full happy-path sequence: IDLE → SOURCE_LOCKED → ANIMATING_SNAP → IDLE', () => {
    let phase = InteractionPhase.IDLE;
    phase = InteractionEvents.lockSource(phase);
    expect(phase).toBe(InteractionPhase.SOURCE_LOCKED);
    phase = InteractionEvents.beginSnap(phase);
    expect(phase).toBe(InteractionPhase.ANIMATING_SNAP);
    phase = InteractionEvents.completeSnap(phase);
    expect(phase).toBe(InteractionPhase.IDLE);
  });

  it('cancel path: IDLE → SOURCE_LOCKED → IDLE', () => {
    let phase = InteractionPhase.IDLE;
    phase = InteractionEvents.lockSource(phase);
    phase = InteractionEvents.cancel(phase);
    expect(phase).toBe(InteractionPhase.IDLE);
  });
});

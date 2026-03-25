import { describe, it, expect } from 'vitest';
import { InteractionPhase } from '../types';
import {
  isValidTransition,
  transition,
  InteractionEvents,
} from '../interactionFSM';

// ---------------------------------------------------------------------------
// isValidTransition
// ---------------------------------------------------------------------------

describe('isValidTransition', () => {
  it('IDLE → PREVIEWING is valid', () => {
    expect(isValidTransition(InteractionPhase.IDLE, InteractionPhase.PREVIEWING)).toBe(true);
  });

  it('PREVIEWING → SOURCE_LOCKED is valid', () => {
    expect(isValidTransition(InteractionPhase.PREVIEWING, InteractionPhase.SOURCE_LOCKED)).toBe(true);
  });

  it('PREVIEWING → IDLE is valid', () => {
    expect(isValidTransition(InteractionPhase.PREVIEWING, InteractionPhase.IDLE)).toBe(true);
  });

  it('IDLE → SOURCE_LOCKED is valid', () => {
    expect(isValidTransition(InteractionPhase.IDLE, InteractionPhase.SOURCE_LOCKED)).toBe(true);
  });

  it('IDLE → ANIMATING_SNAP is NOT valid', () => {
    expect(isValidTransition(InteractionPhase.IDLE, InteractionPhase.ANIMATING_SNAP)).toBe(false);
  });

  it('IDLE → IDLE is valid (self-transition)', () => {
    expect(isValidTransition(InteractionPhase.IDLE, InteractionPhase.IDLE)).toBe(true);
  });

  it('SOURCE_LOCKED → IDLE is valid (abort)', () => {
    expect(isValidTransition(InteractionPhase.SOURCE_LOCKED, InteractionPhase.IDLE)).toBe(true);
  });

  it('SOURCE_LOCKED → ANIMATING_SNAP is valid', () => {
    expect(isValidTransition(InteractionPhase.SOURCE_LOCKED, InteractionPhase.ANIMATING_SNAP)).toBe(true);
  });

  it('SOURCE_LOCKED → AXIAL_SLIDING is valid', () => {
    expect(isValidTransition(InteractionPhase.SOURCE_LOCKED, InteractionPhase.AXIAL_SLIDING)).toBe(true);
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
});

// ---------------------------------------------------------------------------
// InteractionEvents
// ---------------------------------------------------------------------------

describe('InteractionEvents', () => {
  it('previewPart: IDLE → PREVIEWING', () => {
    expect(InteractionEvents.previewPart(InteractionPhase.IDLE))
      .toBe(InteractionPhase.PREVIEWING);
  });

  it('pickSourcePort: PREVIEWING → SOURCE_LOCKED', () => {
    expect(InteractionEvents.pickSourcePort(InteractionPhase.PREVIEWING))
      .toBe(InteractionPhase.SOURCE_LOCKED);
  });

  it('abort: SOURCE_LOCKED → IDLE', () => {
    expect(InteractionEvents.abort(InteractionPhase.SOURCE_LOCKED))
      .toBe(InteractionPhase.IDLE);
  });

  it('beginSnap: SOURCE_LOCKED → ANIMATING_SNAP', () => {
    expect(InteractionEvents.beginSnap(InteractionPhase.SOURCE_LOCKED))
      .toBe(InteractionPhase.ANIMATING_SNAP);
  });

  it('beginSliding: SOURCE_LOCKED → AXIAL_SLIDING', () => {
    expect(InteractionEvents.beginSliding(InteractionPhase.SOURCE_LOCKED))
      .toBe(InteractionPhase.AXIAL_SLIDING);
  });

  it('completeSnap: ANIMATING_SNAP → IDLE', () => {
    expect(InteractionEvents.completeSnap(InteractionPhase.ANIMATING_SNAP))
      .toBe(InteractionPhase.IDLE);
  });

  it('full library-to-snap flow: IDLE → PREVIEWING → LOCKED → ANIMATING → IDLE', () => {
    let phase = InteractionPhase.IDLE;
    phase = InteractionEvents.previewPart(phase);
    expect(phase).toBe(InteractionPhase.PREVIEWING);
    phase = InteractionEvents.pickSourcePort(phase);
    expect(phase).toBe(InteractionPhase.SOURCE_LOCKED);
    phase = InteractionEvents.beginSnap(phase);
    expect(phase).toBe(InteractionPhase.ANIMATING_SNAP);
    phase = InteractionEvents.completeSnap(phase);
    expect(phase).toBe(InteractionPhase.IDLE);
  });
});

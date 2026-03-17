/**
 * workbench.test.ts
 * ==================
 * ZoneType 枚举与 WorkbenchGrid 的单元测试。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ZoneType, WorkbenchGrid } from './workbench';

// ---------------------------------------------------------------------------
// ZoneType
// ---------------------------------------------------------------------------

describe('ZoneType', () => {
  it('has three zones', () => {
    expect(Object.values(ZoneType)).toHaveLength(3);
  });

  it('ACTIVE_ARENA value is correct', () => {
    expect(ZoneType.ACTIVE_ARENA).toBe('ACTIVE_ARENA');
  });

  it('WORKBENCH value is correct', () => {
    expect(ZoneType.WORKBENCH).toBe('WORKBENCH');
  });

  it('PREVIEW value is correct', () => {
    expect(ZoneType.PREVIEW).toBe('PREVIEW');
  });
});

// ---------------------------------------------------------------------------
// WorkbenchGrid
// ---------------------------------------------------------------------------

describe('WorkbenchGrid', () => {

  let grid: WorkbenchGrid;

  beforeEach(() => {
    grid = new WorkbenchGrid(2, 3); // 2 rows × 3 cols = 6 slots
  });

  // ── 初始状态 ──────────────────────────────────────────────────────────────

  describe('construction', () => {
    it('creates rows × cols slots', () => {
      expect(grid.slots).toHaveLength(6);
    });

    it('capacity equals rows × cols', () => {
      expect(grid.capacity).toBe(6);
    });

    it('all slots start unoccupied', () => {
      expect(grid.slots.every(s => s.occupiedBy === null)).toBe(true);
    });

    it('freeCount equals capacity initially', () => {
      expect(grid.freeCount).toBe(6);
    });

    it('slot indices are sequential', () => {
      const indices = grid.slots.map(s => s.index);
      expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('slot gridRow and gridCol are correct', () => {
      // row=0, col=0 → index 0
      expect(grid.slots[0].gridRow).toBe(0);
      expect(grid.slots[0].gridCol).toBe(0);
      // row=0, col=2 → index 2
      expect(grid.slots[2].gridRow).toBe(0);
      expect(grid.slots[2].gridCol).toBe(2);
      // row=1, col=0 → index 3
      expect(grid.slots[3].gridRow).toBe(1);
      expect(grid.slots[3].gridCol).toBe(0);
    });

    it('worldPosition Y equals workbenchY (default 0)', () => {
      for (const slot of grid.slots) {
        expect(slot.worldPosition[1]).toBeCloseTo(0);
      }
    });

    it('adjacent slots have different X or Z positions', () => {
      const s0 = grid.slots[0];
      const s1 = grid.slots[1]; // same row, next col
      expect(s1.worldPosition[0]).toBeGreaterThan(s0.worldPosition[0]);
    });
  });

  // ── findNextAvailableSlot ─────────────────────────────────────────────────

  describe('findNextAvailableSlot', () => {
    it('returns first slot when grid is empty', () => {
      const slot = grid.findNextAvailableSlot();
      expect(slot).not.toBeNull();
      expect(slot!.index).toBe(0);
    });

    it('returns null when grid is full', () => {
      for (let i = 0; i < grid.capacity; i++) {
        grid.assign(`sub_${i}`);
      }
      expect(grid.findNextAvailableSlot()).toBeNull();
    });

    it('skips occupied slots', () => {
      grid.assign('A'); // occupies slot 0
      const slot = grid.findNextAvailableSlot();
      expect(slot!.index).toBe(1);
    });
  });

  // ── assign ────────────────────────────────────────────────────────────────

  describe('assign', () => {
    it('returns the assigned slot', () => {
      const slot = grid.assign('SUB_A');
      expect(slot).not.toBeNull();
      expect(slot!.occupiedBy).toBe('SUB_A');
    });

    it('decreases freeCount', () => {
      grid.assign('SUB_A');
      expect(grid.freeCount).toBe(5);
    });

    it('returns null when full', () => {
      for (let i = 0; i < grid.capacity; i++) grid.assign(`sub_${i}`);
      expect(grid.assign('overflow')).toBeNull();
    });

    it('assigns sequentially to first free slots', () => {
      const s0 = grid.assign('A')!;
      const s1 = grid.assign('B')!;
      expect(s0.index).toBe(0);
      expect(s1.index).toBe(1);
    });
  });

  // ── release ───────────────────────────────────────────────────────────────

  describe('release', () => {
    it('returns true for known occupant', () => {
      grid.assign('A');
      expect(grid.release('A')).toBe(true);
    });

    it('returns false for unknown occupant', () => {
      expect(grid.release('NOBODY')).toBe(false);
    });

    it('sets occupiedBy to null', () => {
      const slot = grid.assign('A')!;
      grid.release('A');
      expect(slot.occupiedBy).toBeNull();
    });

    it('freeCount increases after release', () => {
      grid.assign('A');
      grid.release('A');
      expect(grid.freeCount).toBe(grid.capacity);
    });

    it('released slot can be reassigned', () => {
      grid.assign('A');
      grid.release('A');
      const slot = grid.assign('B');
      expect(slot).not.toBeNull();
      expect(slot!.index).toBe(0); // first slot again
    });
  });

  // ── findByOccupant ────────────────────────────────────────────────────────

  describe('findByOccupant', () => {
    it('returns the slot occupied by the given ID', () => {
      const assigned = grid.assign('A')!;
      const found = grid.findByOccupant('A');
      expect(found).toBe(assigned);
    });

    it('returns null for unknown occupant', () => {
      expect(grid.findByOccupant('NOBODY')).toBeNull();
    });

    it('returns null after release', () => {
      grid.assign('A');
      grid.release('A');
      expect(grid.findByOccupant('A')).toBeNull();
    });
  });

  // ── 端到端场景 ────────────────────────────────────────────────────────────

  describe('end-to-end: detach and recycle flow', () => {
    it('assign → release → reassign works correctly', () => {
      grid.assign('SUB_1');
      grid.assign('SUB_2');
      grid.release('SUB_1');

      const newSlot = grid.assign('SUB_3')!;
      expect(newSlot.index).toBe(0); // slot 0 was freed by SUB_1
      expect(grid.freeCount).toBe(grid.capacity - 2);
    });

    it('full grid blocks new assignments after capacity', () => {
      for (let i = 0; i < grid.capacity; i++) grid.assign(`sub_${i}`);
      expect(grid.freeCount).toBe(0);
      expect(grid.assign('extra')).toBeNull();
      expect(grid.findNextAvailableSlot()).toBeNull();
    });
  });
});

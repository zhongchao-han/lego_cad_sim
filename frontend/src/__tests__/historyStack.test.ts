/**
 * historyStack.test.ts
 * =====================
 * HistoryStack 和 createSnapCommand 的单元测试。
 */

import { describe, it, expect, vi } from 'vitest';
import { HistoryStack, createSnapCommand, type ActionCommand, type SnapSnapshot } from './historyStack';

// ---------------------------------------------------------------------------
// 辅助：构建测试用命令
// ---------------------------------------------------------------------------

function makeCmd(label: string): ActionCommand & { executeCalled: number; undoCalled: number } {
  const cmd = {
    type: label,
    snapshot: {},
    executeCalled: 0,
    undoCalled: 0,
    execute() { this.executeCalled++; },
    undo()    { this.undoCalled++; },
  };
  return cmd;
}

// ---------------------------------------------------------------------------
// HistoryStack — 基础行为
// ---------------------------------------------------------------------------

describe('HistoryStack', () => {

  describe('initial state', () => {
    it('canUndo is false on empty stack', () => {
      expect(new HistoryStack().canUndo).toBe(false);
    });

    it('canRedo is false on empty stack', () => {
      expect(new HistoryStack().canRedo).toBe(false);
    });

    it('pastCount and futureCount are 0', () => {
      const h = new HistoryStack();
      expect(h.pastCount).toBe(0);
      expect(h.futureCount).toBe(0);
    });
  });

  describe('push', () => {
    it('increases pastCount', () => {
      const h = new HistoryStack();
      h.push(makeCmd('A'));
      expect(h.pastCount).toBe(1);
    });

    it('canUndo becomes true after push', () => {
      const h = new HistoryStack();
      h.push(makeCmd('A'));
      expect(h.canUndo).toBe(true);
    });

    it('push clears future stack', () => {
      const h = new HistoryStack();
      const c1 = makeCmd('A');
      const c2 = makeCmd('B');
      h.push(c1);
      h.undo();           // c1 moves to future
      expect(h.canRedo).toBe(true);
      h.push(c2);         // new action clears future
      expect(h.canRedo).toBe(false);
      expect(h.futureCount).toBe(0);
    });
  });

  describe('undo', () => {
    it('calls undo() on the most recent command', () => {
      const h = new HistoryStack();
      const cmd = makeCmd('A');
      h.push(cmd);
      h.undo();
      expect(cmd.undoCalled).toBe(1);
    });

    it('undo on empty stack returns false', () => {
      expect(new HistoryStack().undo()).toBe(false);
    });

    it('moves command from past to future', () => {
      const h = new HistoryStack();
      h.push(makeCmd('A'));
      h.undo();
      expect(h.pastCount).toBe(0);
      expect(h.futureCount).toBe(1);
    });

    it('multiple undos in sequence', () => {
      const h = new HistoryStack();
      const c1 = makeCmd('A');
      const c2 = makeCmd('B');
      h.push(c1);
      h.push(c2);
      h.undo();
      h.undo();
      expect(c2.undoCalled).toBe(1);
      expect(c1.undoCalled).toBe(1);
    });
  });

  describe('redo', () => {
    it('calls execute() on the command', () => {
      const h = new HistoryStack();
      const cmd = makeCmd('A');
      h.push(cmd);
      h.undo();
      h.redo();
      expect(cmd.executeCalled).toBe(1);
    });

    it('redo on empty future returns false', () => {
      expect(new HistoryStack().redo()).toBe(false);
    });

    it('moves command from future to past', () => {
      const h = new HistoryStack();
      h.push(makeCmd('A'));
      h.undo();
      h.redo();
      expect(h.pastCount).toBe(1);
      expect(h.futureCount).toBe(0);
    });

    it('undo then redo restores canRedo state', () => {
      const h = new HistoryStack();
      h.push(makeCmd('A'));
      h.undo();
      expect(h.canRedo).toBe(true);
      h.redo();
      expect(h.canRedo).toBe(false);
    });
  });

  describe('maxSize limit', () => {
    it('drops oldest entry when maxSize is exceeded', () => {
      const h = new HistoryStack(3);
      h.push(makeCmd('A'));
      h.push(makeCmd('B'));
      h.push(makeCmd('C'));
      h.push(makeCmd('D')); // A should be dropped
      expect(h.pastCount).toBe(3);
    });

    it('oldest command is not undone when dropped', () => {
      const h = new HistoryStack(2);
      const dropped = makeCmd('dropped');
      h.push(dropped);
      h.push(makeCmd('B'));
      h.push(makeCmd('C')); // dropped is removed
      h.undo();
      h.undo();
      expect(dropped.undoCalled).toBe(0); // never recalled
    });
  });

  describe('clear', () => {
    it('empties both stacks', () => {
      const h = new HistoryStack();
      h.push(makeCmd('A'));
      h.push(makeCmd('B'));
      h.clear();
      expect(h.pastCount).toBe(0);
      expect(h.futureCount).toBe(0);
    });

    it('canUndo and canRedo are false after clear', () => {
      const h = new HistoryStack();
      h.push(makeCmd('A'));
      h.clear();
      expect(h.canUndo).toBe(false);
      expect(h.canRedo).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// createSnapCommand
// ---------------------------------------------------------------------------

describe('createSnapCommand', () => {

  function makeSnapshot(): SnapSnapshot {
    return {
      movedPartIds: ['PIN'],
      prevPositions: {
        'PIN': { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      },
      addedConnections: [{ from: 'PIN', to: 'BEAM_A' }],
    };
  }

  it('type is SNAP', () => {
    const cmd = createSnapCommand(makeSnapshot(), vi.fn(), vi.fn());
    expect(cmd.type).toBe('SNAP');
  });

  it('snapshot is stored', () => {
    const snap = makeSnapshot();
    const cmd = createSnapCommand(snap, vi.fn(), vi.fn());
    expect(cmd.snapshot).toBe(snap);
  });

  it('execute calls applyFn', () => {
    const applyFn = vi.fn();
    const cmd = createSnapCommand(makeSnapshot(), applyFn, vi.fn());
    cmd.execute();
    expect(applyFn).toHaveBeenCalledOnce();
  });

  it('undo calls revertFn with the snapshot', () => {
    const snap = makeSnapshot();
    const revertFn = vi.fn();
    const cmd = createSnapCommand(snap, vi.fn(), revertFn);
    cmd.undo();
    expect(revertFn).toHaveBeenCalledWith(snap);
  });

  it('undo does NOT call applyFn', () => {
    const applyFn = vi.fn();
    const cmd = createSnapCommand(makeSnapshot(), applyFn, vi.fn());
    cmd.undo();
    expect(applyFn).not.toHaveBeenCalled();
  });

  it('can be used with HistoryStack', () => {
    const h = new HistoryStack();
    const revertFn = vi.fn();
    h.push(createSnapCommand(makeSnapshot(), vi.fn(), revertFn));
    h.undo();
    expect(revertFn).toHaveBeenCalledOnce();
  });
});

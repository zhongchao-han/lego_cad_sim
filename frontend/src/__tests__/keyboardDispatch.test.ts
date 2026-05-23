/**
 * keyboardDispatch.test.ts
 * =========================
 * 走法 A 期 #64 C.2 — 表驱动 dispatcher 的"直测"路径。
 *
 * 与 useKeyboardDispatcher.test.tsx 互补：
 *   - useKeyboardDispatcher.test.tsx 走 React + jsdom event 派发 + 真实 store
 *     副作用断言（端到端，慢）
 *   - 本文件直接喂 `dispatchKey(KeyboardEvent, mockDeps)` 验返回 entry id +
 *     spy 调用次数（O(ms) 级，hot loop 加速）
 *
 * 覆盖：
 *   1. First-match-wins 顺序（Esc + 搜索开 > input-focus > 其他）
 *   2. 同 key 不同修饰键的拆分（Cmd+Z / Cmd+Shift+Z / Cmd+Y 各走自己 entry）
 *   3. Alt+H 必须先于裸 H 命中（否则裸 H 会先吃，造成"先 hide 再 show"的隐 bug）
 *   4. input-focus 守卫返早 id（不会落到 Cmd+K open-search）
 *   5. axle 端口屏蔽旋转
 *   6. AXIAL_SLIDING phase 才接 ArrowUp/Down/Enter
 *   7. KEYMAP id 全局唯一 — 防 typo / 重复 entry
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  KEYMAP,
  dispatchKey,
  type DispatcherDeps,
} from '../hooks/keyboardDispatch';
import { InteractionPhase } from '../types';

// ─── 测试夹具 ────────────────────────────────────────────────────────────────

const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number[], number[], number[]];

function makePort(partId: string, portType: string = 'peg.dat') {
  return {
    partId,
    ldrawId: `${partId}.dat`,
    portType,
    position: [0, 0, 0] as [number, number, number],
    rotation: EYE3,
    globalPos: [0, 0, 0] as [number, number, number],
    globalQuat: [0, 0, 0, 1] as [number, number, number, number],
  };
}

/** 构造一个 deps，所有 action 都 spy 化；state getter 按入参返常量。
 *  覆写法：传 overrides 单独改某些 getter，比如 `{ isSearchOpen: () => true }`。 */
function makeMockDeps(overrides: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    isSearchOpen: () => false,
    interactionPhase: () => InteractionPhase.IDLE,
    selectedPort: () => null,
    slidingTarget: () => null,
    slideOffset: () => 0,
    hasSelection: () => false,

    setSearchOpen: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    copySelected: vi.fn(),
    pasteClipboard: vi.fn(),
    duplicateSelected: vi.fn(),
    selectAll: vi.fn(),
    deselectAll: vi.fn(),
    deleteSelected: vi.fn(),
    abortCurrentInteraction: vi.fn(),
    setHiddenSelected: vi.fn(),
    showAll: vi.fn(),
    focusCameraOnSelected: vi.fn(),
    rotateSelectedPart: vi.fn(),
    rotateSelectedGroup: vi.fn(),
    rotateSelectedSingle: vi.fn(),
    flipSelected: vi.fn(),
    translateSelectedGroup: vi.fn(),
    commitFreePlacing: vi.fn(),
    commitAxialSliding: vi.fn(),
    updateSlideOffset: vi.fn(),
    addLog: vi.fn(),
    ...overrides,
  };
}

function kev(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, ...init });
}

// ─── 1. KEYMAP 结构本身 ──────────────────────────────────────────────────────

describe('KEYMAP 结构契约', () => {
  it('case 1: 所有 entry.id 全局唯一', () => {
    const ids = KEYMAP.map(e => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, `重复 id: ${dupes.join(', ')}`).toEqual([]);
  });

  it('case 2: 所有 entry 都有 id / match / run 三件套', () => {
    for (const e of KEYMAP) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.match).toBe('function');
      expect(typeof e.run).toBe('function');
    }
  });
});

// ─── 2. First-match-wins 优先级 ─────────────────────────────────────────────

describe('dispatchKey first-match-wins 优先级', () => {
  let deps: DispatcherDeps;
  beforeEach(() => { deps = makeMockDeps(); });

  it('case 3: Esc + 搜索开 → 走 "esc.search-open"，不落 "esc.default.abort-deselect"', () => {
    deps = makeMockDeps({ isSearchOpen: () => true });
    const id = dispatchKey(kev({ key: 'Escape' }), deps);
    expect(id).toBe('esc.search-open');
    expect(deps.setSearchOpen).toHaveBeenCalledWith(false);
    expect(deps.abortCurrentInteraction).not.toHaveBeenCalled();
    expect(deps.deselectAll).not.toHaveBeenCalled();
  });

  it('case 4: Esc + FREE_PLACING → 走 "esc.free-placing.commit-abort"', () => {
    deps = makeMockDeps({ interactionPhase: () => InteractionPhase.FREE_PLACING });
    const id = dispatchKey(kev({ key: 'Escape' }), deps);
    expect(id).toBe('esc.free-placing.commit-abort');
    expect(deps.commitFreePlacing).toHaveBeenCalledWith(undefined);
    // 不会顺手 abort + deselect — 这是 #61 修法 B 的关键，避免两路并发中间态
    expect(deps.abortCurrentInteraction).not.toHaveBeenCalled();
  });

  it('case 5: Esc + IDLE → fallback "esc.default.abort-deselect"', () => {
    const id = dispatchKey(kev({ key: 'Escape' }), deps);
    expect(id).toBe('esc.default.abort-deselect');
    expect(deps.abortCurrentInteraction).toHaveBeenCalled();
    expect(deps.deselectAll).toHaveBeenCalled();
  });

  it('case 6: Esc + 搜索开 + FREE_PLACING → 优先关搜索（搜索 entry id 顺序更前）', () => {
    // 双重命中场景：搜索面板开 + phase=FREE_PLACING。表驱动 first-match-wins
    // 让搜索 entry 赢，避免误 commit free-placing。
    deps = makeMockDeps({
      isSearchOpen: () => true,
      interactionPhase: () => InteractionPhase.FREE_PLACING,
    });
    const id = dispatchKey(kev({ key: 'Escape' }), deps);
    expect(id).toBe('esc.search-open');
    expect(deps.commitFreePlacing).not.toHaveBeenCalled();
  });
});

// ─── 3. 修饰键拆分 ──────────────────────────────────────────────────────────

describe('Cmd/Ctrl 修饰键 — 同 key 不同修饰拆 entry', () => {
  let deps: DispatcherDeps;
  beforeEach(() => { deps = makeMockDeps(); });

  it('case 7: Cmd+Z → "cmd.z.undo"', () => {
    expect(dispatchKey(kev({ key: 'z', metaKey: true }), deps)).toBe('cmd.z.undo');
    expect(deps.undo).toHaveBeenCalled();
    expect(deps.redo).not.toHaveBeenCalled();
  });

  it('case 8: Cmd+Shift+Z → "cmd.shift-z.redo"（不是 undo）', () => {
    expect(dispatchKey(kev({ key: 'z', metaKey: true, shiftKey: true }), deps))
      .toBe('cmd.shift-z.redo');
    expect(deps.redo).toHaveBeenCalled();
    expect(deps.undo).not.toHaveBeenCalled();
  });

  it('case 9: Ctrl+Y → "cmd.y.redo"', () => {
    expect(dispatchKey(kev({ key: 'y', ctrlKey: true }), deps)).toBe('cmd.y.redo');
    expect(deps.redo).toHaveBeenCalled();
  });

  it('case 10: Cmd+K → "cmd.k.open-search" 即便搜索已开（开就是开，无副作用）', () => {
    deps = makeMockDeps({ isSearchOpen: () => true });
    // 注意：Cmd+K 不带 Esc，所以"esc.search-open"那条不会先吃
    expect(dispatchKey(kev({ key: 'k', metaKey: true }), deps)).toBe('cmd.k.open-search');
    expect(deps.setSearchOpen).toHaveBeenCalledWith(true);
  });
});

// ─── 4. Alt+H vs H 优先级（latent bug 修复） ──────────────────────────────────

describe('Alt+H 必须先于裸 H 命中', () => {
  it('case 11: Alt+H → "alt.h.show-all"，不落 "h.hide-selected"', () => {
    const deps = makeMockDeps();
    const id = dispatchKey(kev({ key: 'h', altKey: true }), deps);
    expect(id).toBe('alt.h.show-all');
    expect(deps.showAll).toHaveBeenCalled();
    expect(deps.setHiddenSelected).not.toHaveBeenCalled();
  });

  it('case 12: 裸 H（无 Alt）→ "h.hide-selected"', () => {
    const deps = makeMockDeps();
    const id = dispatchKey(kev({ key: 'h' }), deps);
    expect(id).toBe('h.hide-selected');
    expect(deps.setHiddenSelected).toHaveBeenCalledWith(true);
    expect(deps.showAll).not.toHaveBeenCalled();
  });

  it('case 13: Cmd+H（不带 Alt）→ 不命中任何 entry（不是 Cmd 系映射的键）', () => {
    // 防止 "alt.h.show-all" 的 match 误用 e.altKey || ... 类宽松判定
    const deps = makeMockDeps();
    expect(dispatchKey(kev({ key: 'h', metaKey: true }), deps)).toBeNull();
    expect(deps.showAll).not.toHaveBeenCalled();
    expect(deps.setHiddenSelected).not.toHaveBeenCalled();
  });
});

// ─── 5. input-focus 守卫 ────────────────────────────────────────────────────

describe('input-focus 守卫', () => {
  let inputEl: HTMLInputElement;
  beforeEach(() => {
    inputEl = document.createElement('input');
    document.body.appendChild(inputEl);
    inputEl.focus();
  });
  afterEach(() => {
    inputEl.remove();
  });

  it('case 14: input focused + F → 走 "input-focus.shortcircuit"，不调 focusCameraOnSelected', () => {
    const deps = makeMockDeps();
    const id = dispatchKey(kev({ key: 'f' }), deps);
    expect(id).toBe('input-focus.shortcircuit');
    expect(deps.focusCameraOnSelected).not.toHaveBeenCalled();
  });

  it('case 15: input focused + Cmd+K → 仍被守卫吃掉（不开搜索）', () => {
    const deps = makeMockDeps();
    const id = dispatchKey(kev({ key: 'k', metaKey: true }), deps);
    expect(id).toBe('input-focus.shortcircuit');
    expect(deps.setSearchOpen).not.toHaveBeenCalled();
  });

  it('case 16: input focused + Esc + 搜索开 → 仍关搜索（"esc.search-open" 优先级最高）', () => {
    const deps = makeMockDeps({ isSearchOpen: () => true });
    const id = dispatchKey(kev({ key: 'Escape' }), deps);
    expect(id).toBe('esc.search-open');
    expect(deps.setSearchOpen).toHaveBeenCalledWith(false);
  });
});

// ─── 6. 旋转 [/] axle gate ──────────────────────────────────────────────────

describe('旋转 [/] phase + axle gate', () => {
  it('case 17: SOURCE_LOCKED + 非 axle 端口 + [ → "rotate.ccw"', () => {
    const deps = makeMockDeps({
      interactionPhase: () => InteractionPhase.SOURCE_LOCKED,
      selectedPort: () => makePort('A', 'peg.dat'),
    });
    expect(dispatchKey(kev({ key: '[' }), deps)).toBe('rotate.ccw');
    expect(deps.rotateSelectedPart).toHaveBeenCalledWith(-Math.PI / 2);
  });

  it('case 18: AXIAL_SLIDING + 非 axle + ] → "rotate.cw"（顺时针）', () => {
    const deps = makeMockDeps({
      interactionPhase: () => InteractionPhase.AXIAL_SLIDING,
      selectedPort: () => makePort('A', 'peghole.dat'),
    });
    expect(dispatchKey(kev({ key: ']' }), deps)).toBe('rotate.cw');
    expect(deps.rotateSelectedPart).toHaveBeenCalledWith(Math.PI / 2);
  });

  it('case 19: SOURCE_LOCKED + axle 端口 + [ → 不命中（轴心连接不允许旋转）', () => {
    const deps = makeMockDeps({
      interactionPhase: () => InteractionPhase.SOURCE_LOCKED,
      selectedPort: () => makePort('A', 'axle.dat'),
    });
    expect(dispatchKey(kev({ key: '[' }), deps)).toBeNull();
    expect(deps.rotateSelectedPart).not.toHaveBeenCalled();
  });

  it('case 20: IDLE phase + [ → 不命中（无源端口不能旋转）', () => {
    const deps = makeMockDeps();
    expect(dispatchKey(kev({ key: '[' }), deps)).toBeNull();
  });
});

// ─── 7. AXIAL_SLIDING phase gate ─────────────────────────────────────────────

describe('AXIAL_SLIDING phase 专属', () => {
  it('case 21: AXIAL_SLIDING + Enter → "axial.enter.commit" + commitAxialSliding + deselectAll', () => {
    const deps = makeMockDeps({
      interactionPhase: () => InteractionPhase.AXIAL_SLIDING,
    });
    expect(dispatchKey(kev({ key: 'Enter' }), deps)).toBe('axial.enter.commit');
    expect(deps.commitAxialSliding).toHaveBeenCalled();
    expect(deps.deselectAll).toHaveBeenCalled();
  });

  it('case 22: IDLE + Enter → 不命中（Enter 不是 IDLE 下的快捷键）', () => {
    const deps = makeMockDeps();
    expect(dispatchKey(kev({ key: 'Enter' }), deps)).toBeNull();
    expect(deps.commitAxialSliding).not.toHaveBeenCalled();
  });

  it('case 23: AXIAL_SLIDING + ArrowUp (no shift, peg×peghole CLEARANCE) → step +1', () => {
    const deps = makeMockDeps({
      interactionPhase: () => InteractionPhase.AXIAL_SLIDING,
      selectedPort: () => makePort('A', 'peg.dat'),
      slidingTarget: () => makePort('B', 'peghole.dat'),
      slideOffset: () => 5,
    });
    expect(dispatchKey(kev({ key: 'ArrowUp' }), deps)).toBe('axial.up.slide-plus');
    // step 计算：base 1 × CLEARANCE factor (=1) = 1。从 offset=5 加 1 → 6
    expect(deps.updateSlideOffset).toHaveBeenCalledWith(6, false);
  });

  it('case 24: AXIAL_SLIDING + Shift+ArrowDown → step -10', () => {
    const deps = makeMockDeps({
      interactionPhase: () => InteractionPhase.AXIAL_SLIDING,
      selectedPort: () => makePort('A', 'peg.dat'),
      slidingTarget: () => makePort('B', 'peghole.dat'),
      slideOffset: () => 50,
    });
    expect(dispatchKey(kev({ key: 'ArrowDown', shiftKey: true }), deps))
      .toBe('axial.down.slide-minus');
    expect(deps.updateSlideOffset).toHaveBeenCalledWith(40, true);
  });

  it('case 25: IDLE + ArrowUp → 不命中（不在 sliding phase）', () => {
    const deps = makeMockDeps();
    expect(dispatchKey(kev({ key: 'ArrowUp' }), deps)).toBeNull();
    expect(deps.updateSlideOffset).not.toHaveBeenCalled();
  });
});

// ─── 8. 未命中 / 无操作键 ────────────────────────────────────────────────────

describe('未命中', () => {
  it('case 26: 随便按个 Q → 不命中任何 entry（返 null）', () => {
    const deps = makeMockDeps();
    expect(dispatchKey(kev({ key: 'q' }), deps)).toBeNull();
  });
});

// ─── 9. 已放置零件自由编辑（IDLE + selection）──────────────────────────────────

describe('IDLE + 选中零件：[/] 旋转整组、方向键平移整组', () => {
  const LDU = 0.0004;
  const STEP = 20 * LDU;   // 默认一格
  const FINE = 4 * LDU;    // Shift 细调
  const idleSel = (over = {}) => makeMockDeps({
    interactionPhase: () => InteractionPhase.IDLE,
    hasSelection: () => true,
    ...over,
  });

  it('case 27: IDLE+selection + [ → "idle.rotate-single.ccw" 只转选中件 -90°', () => {
    const deps = idleSel();
    expect(dispatchKey(kev({ key: '[' }), deps)).toBe('idle.rotate-single.ccw');
    expect(deps.rotateSelectedSingle).toHaveBeenCalledWith(-Math.PI / 2);
  });

  it('case 28: IDLE+selection + ] → "idle.rotate-single.cw" 只转选中件 +90°', () => {
    const deps = idleSel();
    expect(dispatchKey(kev({ key: ']' }), deps)).toBe('idle.rotate-single.cw');
    expect(deps.rotateSelectedSingle).toHaveBeenCalledWith(Math.PI / 2);
  });

  it('case 29: IDLE+selection + 方向键 → 平移整组（world X/Z，默认 20 LDU）', () => {
    let deps = idleSel();
    expect(dispatchKey(kev({ key: 'ArrowLeft' }), deps)).toBe('idle.translate.left');
    expect(deps.translateSelectedGroup).toHaveBeenCalledWith([-STEP, 0, 0]);

    deps = idleSel();
    expect(dispatchKey(kev({ key: 'ArrowRight' }), deps)).toBe('idle.translate.right');
    expect(deps.translateSelectedGroup).toHaveBeenCalledWith([STEP, 0, 0]);

    deps = idleSel();
    expect(dispatchKey(kev({ key: 'ArrowUp' }), deps)).toBe('idle.translate.away');
    expect(deps.translateSelectedGroup).toHaveBeenCalledWith([0, 0, -STEP]);

    deps = idleSel();
    expect(dispatchKey(kev({ key: 'ArrowDown' }), deps)).toBe('idle.translate.toward');
    expect(deps.translateSelectedGroup).toHaveBeenCalledWith([0, 0, STEP]);
  });

  it('case 30: Shift+方向键 → 细调步长 4 LDU', () => {
    const deps = idleSel();
    expect(dispatchKey(kev({ key: 'ArrowLeft', shiftKey: true }), deps)).toBe('idle.translate.left');
    expect(deps.translateSelectedGroup).toHaveBeenCalledWith([-FINE, 0, 0]);
  });

  it('case 31: IDLE 但无选中 → [/] 与方向键都不命中（返 null）', () => {
    const deps = makeMockDeps({ interactionPhase: () => InteractionPhase.IDLE, hasSelection: () => false });
    expect(dispatchKey(kev({ key: '[' }), deps)).toBeNull();
    expect(dispatchKey(kev({ key: 'ArrowLeft' }), deps)).toBeNull();
    expect(deps.rotateSelectedSingle).not.toHaveBeenCalled();
    expect(deps.translateSelectedGroup).not.toHaveBeenCalled();
  });

  it('case 33: IDLE+selection + Shift+F → "idle.flip-selected" 翻面', () => {
    const deps = idleSel();
    expect(dispatchKey(kev({ key: 'F', shiftKey: true }), deps)).toBe('idle.flip-selected');
    expect(deps.flipSelected).toHaveBeenCalled();
  });

  it('case 34: 裸 f → focus（非翻面）；Shift+F 无选中 → 落到 focus', () => {
    const sel = idleSel();
    expect(dispatchKey(kev({ key: 'f' }), sel)).toBe('f.focus-camera');
    expect(sel.flipSelected).not.toHaveBeenCalled();

    const noSel = makeMockDeps({ interactionPhase: () => InteractionPhase.IDLE, hasSelection: () => false });
    expect(dispatchKey(kev({ key: 'F', shiftKey: true }), noSel)).toBe('f.focus-camera');
    expect(noSel.flipSelected).not.toHaveBeenCalled();
  });

  it('case 32: SOURCE_LOCKED 端口旋转优先 — [ 走 "rotate.ccw" 而非 idle 组旋转', () => {
    // phase 互斥：SOURCE_LOCKED + 端口在时走端口旋转，不会落到 idle 组编辑
    const deps = makeMockDeps({
      interactionPhase: () => InteractionPhase.SOURCE_LOCKED,
      selectedPort: () => makePort('A', 'peg.dat'),
      hasSelection: () => true,
    });
    expect(dispatchKey(kev({ key: '[' }), deps)).toBe('rotate.ccw');
    expect(deps.rotateSelectedPart).toHaveBeenCalled();
    expect(deps.rotateSelectedSingle).not.toHaveBeenCalled();
  });
});

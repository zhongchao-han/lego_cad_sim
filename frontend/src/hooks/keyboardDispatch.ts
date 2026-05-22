/**
 * keyboardDispatch.ts
 * ====================
 * 走法 A 期 #64 C.2 — keymap 表 + 纯 dispatchKey 函数。
 *
 * 原 useKeyboardDispatcher 200 行 switch/if 嵌在 useEffect 里：
 *   - 加快捷键要找对 switch 分支、注意优先级、避免破坏 input-focus 守卫
 *   - 单测必须走 jsdom dispatchEvent 路径，跑得慢且不直观
 *   - 状态闭包捕获导致 useEffect 频繁 re-bind
 *
 * 现在表驱动 — `KEYMAP` 数组按优先级从高到低声明每条路由：
 *   { id, match(e, deps), run(e, deps) }
 *
 * `dispatchKey(e, deps)` 走 first-match-wins，返命中 entry id（用于单测断言 +
 * 未来加 telemetry）。
 *
 * Deps 全部走 getter（每次事件 useStore.getState() 实时读），handler 不闭包
 * 捕获 state → hook 端 useEffect 空 deps 数组即可，不再 re-bind。
 *
 * 设计约束：
 *   - match / run 都是纯函数（fnA(eventA, mockDepsA) === fnA(eventA, mockDepsA)）
 *   - 不直接 import useStore — deps 走参数注入，单测可 mock
 *   - 不读 DOM 之外的全局（除 document.activeElement，input-focus 守卫专用）
 *   - run 自己负责 preventDefault；match 不能有副作用
 */

import { InteractionPhase } from '../types';
import { fitForSlide, getSlideStepFactor } from '../utils/fitMath';
import type { SelectedPortInfo } from '../types';

const LDU = 0.0004; // 1 LDraw unit in meters（跟 store / SiteGizmo 同源）

// ───── 依赖注入接口 ──────────────────────────────────────────────────────────

/** Dispatcher 运行所需的所有 state getter + actions。
 *
 *  全部用 getter 形式（() => value），保证 handler 在事件时刻读到 *最新*
 *  state；action 字段引用稳定，可直接传函数本体。
 */
export interface DispatcherDeps {
  // ── State getters (实时读)
  isSearchOpen: () => boolean;
  interactionPhase: () => InteractionPhase;
  selectedPort: () => SelectedPortInfo | null;
  slidingTarget: () => SelectedPortInfo | null;
  slideOffset: () => number;
  /** 当前是否有选中的零件（selection.primaryId 非空）。用于 IDLE 下
   *  "选中零件本体后 [/] 旋转、方向键平移"的门控。 */
  hasSelection: () => boolean;

  // ── Actions (引用稳定)
  setSearchOpen: (open: boolean) => void;
  undo: () => void;
  redo: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  duplicateSelected: () => void;
  selectAll: () => void;
  deselectAll: () => void;
  deleteSelected: () => void;
  abortCurrentInteraction: () => void;
  setHiddenSelected: (h: boolean) => void;
  showAll: () => void;
  focusCameraOnSelected: () => void;
  rotateSelectedPart: (rad: number) => void;
  rotateSelectedGroup: (rad: number) => void;
  translateSelectedGroup: (delta: [number, number, number]) => void;
  commitFreePlacing: (target: undefined) => void;
  commitAxialSliding: () => void;
  updateSlideOffset: (offset: number, shift: boolean) => void;
  /** addLog 在 store 上签名是 `(msg, type?: 'INFO'|'ACTION'|'ERROR'|'PHYSICS')`。
   *  这里收窄类型与之对齐，避免 useKeyboardDispatcher 直传时 TS2322。 */
  addLog: (message: string, level?: 'INFO' | 'ACTION' | 'ERROR' | 'PHYSICS') => void;
}

// ───── Keymap entry ──────────────────────────────────────────────────────────

export interface KeymapEntry {
  /** 调试 / 单测断言用的稳定 id。先 layer 后语义，比如 "esc.search-open"。 */
  id: string;
  /** 纯匹配判定：只看 event + state（通过 deps getter）。不能写状态。*/
  match: (e: KeyboardEvent, deps: DispatcherDeps) => boolean;
  /** 命中后执行；自己负责 preventDefault + 调 deps.action。 */
  run: (e: KeyboardEvent, deps: DispatcherDeps) => void;
}

// ───── 辅助谓词（match 内复用，集中改） ──────────────────────────────────────

/** `e.metaKey || e.ctrlKey`（跨平台 Cmd / Ctrl 通用）。 */
const isCmdOrCtrl = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

/** 当前焦点在 INPUT / TEXTAREA / contentEditable —— 不拦快捷键，让浏览器原生处理。
 *
 *  注意：search-close-on-Esc 走在 input-focus 守卫之前（id "esc.search-open"
 *  优先级最高），所以即便焦点在搜索框 input 上 Esc 仍能关搜索。 */
const isInputFocused = (): boolean => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return (el as HTMLElement).isContentEditable === true;
};

/** AXIAL_SLIDING 单次步长。Shift × 10，再按 fit 兼容度缩放（INCOMPATIBLE → 0）。 */
const computeSlideStep = (deps: DispatcherDeps, shiftKey: boolean): number => {
  const baseStep = shiftKey ? 10 : 1;
  const src = deps.selectedPort();
  const tgt = deps.slidingTarget();
  if (!src || !tgt) return baseStep;
  const fit = fitForSlide(src.portType, tgt.portType);
  return baseStep * getSlideStepFactor(fit);
};

/** 旋转许可：SOURCE_LOCKED / AXIAL_SLIDING 下 + 非 axle 端口。
 *
 *  axle 是单轴心连接，旋转语义跟 stud/peg 不同（销头方向是几何固定的），
 *  所以不允许 [/] 转。 */
const canRotateSelectedPort = (deps: DispatcherDeps): boolean => {
  const port = deps.selectedPort();
  if (!port || port.portType.includes('axle')) return false;
  const phase = deps.interactionPhase();
  return phase === InteractionPhase.SOURCE_LOCKED || phase === InteractionPhase.AXIAL_SLIDING;
};

/** 已放置零件自由编辑许可：IDLE 阶段 + 有选中零件。
 *  跟端口旋转（SOURCE_LOCKED/AXIAL_SLIDING）按 phase 互斥，[/]·方向键不会冲突。 */
const canEditSelectedGroup = (deps: DispatcherDeps): boolean =>
  deps.interactionPhase() === InteractionPhase.IDLE && deps.hasSelection();

// 平移步长（米）：默认 1 stud/hole 间距（20 LDU = 8mm，落网格），Shift 细调 4 LDU。
const NUDGE_STEP_M = 20 * LDU;
const NUDGE_FINE_M = 4 * LDU;

// ───── KEYMAP — 按优先级降序声明 ─────────────────────────────────────────────

/**
 * Entry 顺序即优先级，dispatchKey 走 first-match-wins。
 *
 * 编辑指南：
 *   1. 加新快捷键 → 加一个 entry，放到"语义层"对应位置（按下面注释分组）
 *   2. 想跨整个表 short-circuit（比如 input-focus 守卫）→ 加在最顶部，run 内
 *      可什么都不干（input-focus 那条就是空 run，只为吃掉事件）
 *   3. match 要纯：不能 console.log / 不能 setState / 不能 useStore.getState
 *      之外的副作用
 *   4. 同语义不同变体（Shift+Z = Redo / Y = Redo 都映射 redo）拆成多 entry，
 *      不要 if-嵌套
 */
export const KEYMAP: KeymapEntry[] = [
  // ── 顶层守卫 1：Esc + 搜索面板开 → 关搜索（必须先于 input-focus，
  // 因 PartSearchDialog mount 后会自动 focus 自己的 input）
  {
    id: 'esc.search-open',
    match: (e, d) => e.key === 'Escape' && d.isSearchOpen(),
    run: (e, d) => {
      e.preventDefault();
      d.setSearchOpen(false);
    },
  },

  // ── 顶层守卫 2：INPUT / TEXTAREA / contentEditable 焦点 → 全部短路
  {
    id: 'input-focus.shortcircuit',
    match: () => isInputFocused(),
    run: () => {
      // 空 run — 只为吃掉事件，不调 preventDefault（浏览器原生处理）
    },
  },

  // ── Cmd/Ctrl + K：开搜索面板（任何 phase 都生效，input-focus 已守上）
  {
    id: 'cmd.k.open-search',
    match: (e) => isCmdOrCtrl(e) && e.key.toLowerCase() === 'k',
    run: (e, d) => {
      e.preventDefault();
      d.setSearchOpen(true);
    },
  },

  // ── Cmd/Ctrl + 字母：编辑动作
  {
    id: 'cmd.shift-z.redo',
    match: (e) => isCmdOrCtrl(e) && e.shiftKey && e.key.toLowerCase() === 'z',
    run: (e, d) => { e.preventDefault(); d.redo(); },
  },
  {
    id: 'cmd.z.undo',
    match: (e) => isCmdOrCtrl(e) && !e.shiftKey && e.key.toLowerCase() === 'z',
    run: (e, d) => { e.preventDefault(); d.undo(); },
  },
  {
    // Windows 标准 Redo：Ctrl+Y
    id: 'cmd.y.redo',
    match: (e) => isCmdOrCtrl(e) && e.key.toLowerCase() === 'y',
    run: (e, d) => { e.preventDefault(); d.redo(); },
  },
  {
    id: 'cmd.c.copy',
    match: (e) => isCmdOrCtrl(e) && e.key.toLowerCase() === 'c',
    run: (e, d) => { e.preventDefault(); d.copySelected(); },
  },
  {
    id: 'cmd.v.paste',
    match: (e) => isCmdOrCtrl(e) && e.key.toLowerCase() === 'v',
    run: (e, d) => { e.preventDefault(); d.pasteClipboard(); },
  },
  {
    id: 'cmd.d.duplicate',
    match: (e) => isCmdOrCtrl(e) && e.key.toLowerCase() === 'd',
    run: (e, d) => { e.preventDefault(); d.duplicateSelected(); },
  },
  {
    id: 'cmd.a.select-all',
    match: (e) => isCmdOrCtrl(e) && e.key.toLowerCase() === 'a',
    run: (e, d) => { e.preventDefault(); d.selectAll(); },
  },
  {
    id: 'cmd.s.save',
    match: (e) => isCmdOrCtrl(e) && e.key.toLowerCase() === 's',
    run: (e, d) => {
      e.preventDefault();
      // Store 自带 persist，这里仅记 log 给用户反馈
      d.addLog('Manual save triggered.', 'INFO');
    },
  },

  // ── Esc：按 phase 路由
  // FREE_PLACING 走 commitFreePlacing(undefined)（payload 清 + IDLE），
  // 其他 phase 走 abort + deselectAll。
  // 顺序：先匹配 FREE_PLACING 那一条（更具体），再 fallback。
  {
    id: 'esc.free-placing.commit-abort',
    match: (e, d) => e.key === 'Escape' && d.interactionPhase() === InteractionPhase.FREE_PLACING,
    run: (e, d) => {
      e.preventDefault();
      d.commitFreePlacing(undefined);
    },
  },
  {
    id: 'esc.default.abort-deselect',
    match: (e) => e.key === 'Escape',
    run: (e, d) => {
      e.preventDefault();
      d.abortCurrentInteraction();
      d.deselectAll();
    },
  },

  // ── 单键：Delete / Backspace（删选中 part）
  {
    id: 'delete.delete-selected',
    match: (e) => !isCmdOrCtrl(e) && (e.key === 'Delete' || e.key === 'Backspace'),
    run: (e, d) => {
      // Backspace 防浏览器历史后退
      if (e.key === 'Backspace') e.preventDefault();
      d.deleteSelected();
    },
  },

  // ── Alt+H：show all（必须先于裸 H，否则裸 H 那条会先吃掉 Alt+H）
  {
    id: 'alt.h.show-all',
    match: (e) => e.altKey && !isCmdOrCtrl(e) && e.key.toLowerCase() === 'h',
    run: (e, d) => {
      e.preventDefault();
      d.showAll();
    },
  },

  // ── 单键：H（隐藏选中）/ F（focus camera）
  {
    id: 'h.hide-selected',
    match: (e) => !isCmdOrCtrl(e) && !e.altKey && e.key.toLowerCase() === 'h',
    run: (e, d) => {
      e.preventDefault();
      d.setHiddenSelected(true);
    },
  },
  {
    id: 'f.focus-camera',
    match: (e) => !isCmdOrCtrl(e) && e.key.toLowerCase() === 'f',
    run: (e, d) => {
      e.preventDefault();
      d.focusCameraOnSelected();
    },
  },

  // ── AXIAL_SLIDING phase 专属
  {
    id: 'axial.enter.commit',
    match: (e, d) => e.key === 'Enter' && d.interactionPhase() === InteractionPhase.AXIAL_SLIDING,
    run: (e, d) => {
      e.preventDefault();
      d.commitAxialSliding();
      d.deselectAll();
    },
  },
  {
    id: 'axial.up.slide-plus',
    match: (e, d) => e.key === 'ArrowUp' && d.interactionPhase() === InteractionPhase.AXIAL_SLIDING,
    run: (e, d) => {
      e.preventDefault();
      const step = computeSlideStep(d, e.shiftKey);
      if (step !== 0) d.updateSlideOffset(d.slideOffset() + step, e.shiftKey);
    },
  },
  {
    id: 'axial.down.slide-minus',
    match: (e, d) => e.key === 'ArrowDown' && d.interactionPhase() === InteractionPhase.AXIAL_SLIDING,
    run: (e, d) => {
      e.preventDefault();
      const step = computeSlideStep(d, e.shiftKey);
      if (step !== 0) d.updateSlideOffset(d.slideOffset() - step, e.shiftKey);
    },
  },

  // ── 旋转 [/] 或 ArrowLeft/Right（要 selectedPort + 非 axle + 锁定/滑动 phase）
  {
    id: 'rotate.ccw',
    match: (e, d) =>
      (e.key === '[' || e.key === 'ArrowLeft') && canRotateSelectedPort(d),
    run: (e, d) => {
      e.preventDefault();
      d.rotateSelectedPart(-Math.PI / 2);
    },
  },
  {
    id: 'rotate.cw',
    match: (e, d) =>
      (e.key === ']' || e.key === 'ArrowRight') && canRotateSelectedPort(d),
    run: (e, d) => {
      e.preventDefault();
      d.rotateSelectedPart(Math.PI / 2);
    },
  },

  // ── 已放置零件自由编辑（IDLE + 有选中零件）：[/] 绕 Y 转整组、方向键平移整组。
  //    跟上面端口旋转按 phase 互斥（那些要 SOURCE_LOCKED/AXIAL_SLIDING）。
  {
    id: 'idle.rotate-group.ccw',
    match: (e, d) => e.key === '[' && canEditSelectedGroup(d),
    run: (e, d) => { e.preventDefault(); d.rotateSelectedGroup(-Math.PI / 2); },
  },
  {
    id: 'idle.rotate-group.cw',
    match: (e, d) => e.key === ']' && canEditSelectedGroup(d),
    run: (e, d) => { e.preventDefault(); d.rotateSelectedGroup(Math.PI / 2); },
  },
  {
    id: 'idle.translate.left',
    match: (e, d) => e.key === 'ArrowLeft' && canEditSelectedGroup(d),
    run: (e, d) => {
      e.preventDefault();
      const s = e.shiftKey ? NUDGE_FINE_M : NUDGE_STEP_M;
      d.translateSelectedGroup([-s, 0, 0]);
    },
  },
  {
    id: 'idle.translate.right',
    match: (e, d) => e.key === 'ArrowRight' && canEditSelectedGroup(d),
    run: (e, d) => {
      e.preventDefault();
      const s = e.shiftKey ? NUDGE_FINE_M : NUDGE_STEP_M;
      d.translateSelectedGroup([s, 0, 0]);
    },
  },
  {
    id: 'idle.translate.away',
    match: (e, d) => e.key === 'ArrowUp' && canEditSelectedGroup(d),
    run: (e, d) => {
      e.preventDefault();
      const s = e.shiftKey ? NUDGE_FINE_M : NUDGE_STEP_M;
      d.translateSelectedGroup([0, 0, -s]);
    },
  },
  {
    id: 'idle.translate.toward',
    match: (e, d) => e.key === 'ArrowDown' && canEditSelectedGroup(d),
    run: (e, d) => {
      e.preventDefault();
      const s = e.shiftKey ? NUDGE_FINE_M : NUDGE_STEP_M;
      d.translateSelectedGroup([0, 0, s]);
    },
  },
];

// ───── 主入口 ──────────────────────────────────────────────────────────────

/**
 * First-match-wins 调度：找到匹配 entry 就 run + 返 id；无匹配返 null。
 *
 * 单测可以直接 `dispatchKey(new KeyboardEvent('keydown', {key: 'Escape'}), mockDeps)`
 * 跳过 jsdom event dispatching。
 */
export function dispatchKey(e: KeyboardEvent, deps: DispatcherDeps): string | null {
  for (const entry of KEYMAP) {
    if (entry.match(e, deps)) {
      entry.run(e, deps);
      return entry.id;
    }
  }
  return null;
}

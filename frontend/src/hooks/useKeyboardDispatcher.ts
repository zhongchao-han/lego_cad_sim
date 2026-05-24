import { useEffect } from 'react';
import { useStore } from '../store';
import { dispatchKey, type DispatcherDeps } from './keyboardDispatch';

/**
 * 全局键盘 dispatcher（issue #64 #1 / C.1 单 listener；#64 C.2 表驱动重构）。
 *
 * 此 hook 现在只剩三件事：
 *   1. 组装 DispatcherDeps —— state 用 getter 形式（每次事件实时读，
 *      避免闭包陈旧）；actions 直接引用 store 上的方法。
 *   2. 单 window.keydown listener → 调 dispatchKey。
 *   3. unmount 时摘 listener。
 *
 * 路由逻辑、优先级、Esc-在-input-focus-之前的守卫顺序，全部抽到
 * `keyboardDispatch.ts` 的 `KEYMAP` 表里 — 加快捷键改一处、单测可直接喂
 * KeyboardEvent + mock deps 验返回 entry id，不再需要 jsdom 派发 + store
 * 副作用断言。
 *
 * 设计选择：useEffect deps 数组 = []（空）。所有 state 都走 getter →
 * handler 不需要 re-bind。原版每个 interactionPhase / selectedPort 变化
 * 都触发 useEffect 重挂监听器，浪费且容易引入 close-over-stale-state bug。
 */
export function useKeyboardDispatcher() {
  useEffect(() => {
    const deps: DispatcherDeps = {
      // State getters — 用 useStore.getState() 每次事件实时读，杜绝闭包陈旧
      isSearchOpen: () => useStore.getState().isSearchOpen,
      interactionPhase: () => useStore.getState().interactionPhase,
      selectedPort: () => useStore.getState().selectedPort,
      slidingTarget: () => useStore.getState().slidingTarget,
      slideOffset: () => useStore.getState().slideOffset,
      hasSelection: () => useStore.getState().selection.primaryId !== null,

      // Actions — Zustand 保证函数引用稳定，直接取一次即可
      setSearchOpen: useStore.getState().setSearchOpen,
      undo: useStore.getState().undo,
      redo: useStore.getState().redo,
      copySelected: useStore.getState().copySelected,
      pasteClipboard: useStore.getState().pasteClipboard,
      duplicateSelected: useStore.getState().duplicateSelected,
      selectAll: useStore.getState().selectAll,
      deselectAll: useStore.getState().deselectAll,
      deleteSelected: useStore.getState().deleteSelected,
      abortCurrentInteraction: useStore.getState().abortCurrentInteraction,
      setHiddenSelected: useStore.getState().setHiddenSelected,
      showAll: useStore.getState().showAll,
      focusCameraOnSelected: useStore.getState().focusCameraOnSelected,
      rotateSelectedPart: useStore.getState().rotateSelectedPart,
      rotateSelectedGroup: useStore.getState().rotateSelectedGroup,
      rotateSelectedSingle: useStore.getState().rotateSelectedSingle,
      flipSelected: useStore.getState().flipSelected,
      translateSelectedGroup: useStore.getState().translateSelectedGroup,
      commitFreePlacing: useStore.getState().commitFreePlacing,
      commitAxialSliding: useStore.getState().commitAxialSliding,
      updateSlideOffset: useStore.getState().updateSlideOffset,
      addLog: useStore.getState().addLog,
    };

    const handler = (e: KeyboardEvent) => {
      dispatchKey(e, deps);
    };

    // 端口连接修饰键（Alt/Option）跟踪 → store.isPortModifierHeld。端口点只有在
    // 按住 Alt 的"连接模式"才高亮 + 指针手型（见 SiteGizmo），避免裸点选本体时
    // 端口高亮误导。
    //
    // ⚠ 不能只靠 keydown/keyup：在「Mac(Option)→RDP→Windows + 浏览器 Alt 激活菜单/
    // 失焦」这条链路上，Alt 的 keydown/keyup 极易丢失 → isPortModifierHeld 时有时无、
    // 端口"经常不显示"。修法：**也从指针事件同步 altKey**。hover 本身持续产生
    // pointermove，每个事件自带当前 altKey → 不论键盘事件是否到位，移动鼠标即正确。
    // setPortModifierHeld 内有 !== 守卫，值不变不触发渲染，pointermove 高频也安全。
    const syncAlt = (e: KeyboardEvent) => useStore.getState().setPortModifierHeld(e.altKey);
    const syncAltPointer = (e: PointerEvent | MouseEvent) => useStore.getState().setPortModifierHeld(e.altKey);
    const clearAlt = () => useStore.getState().setPortModifierHeld(false);

    window.addEventListener('keydown', handler);
    window.addEventListener('keydown', syncAlt);
    window.addEventListener('keyup', syncAlt);
    window.addEventListener('pointermove', syncAltPointer);
    window.addEventListener('pointerdown', syncAltPointer);
    window.addEventListener('blur', clearAlt);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keydown', syncAlt);
      window.removeEventListener('keyup', syncAlt);
      window.removeEventListener('pointermove', syncAltPointer);
      window.removeEventListener('pointerdown', syncAltPointer);
      window.removeEventListener('blur', clearAlt);
    };
  }, []);
}

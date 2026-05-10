import { useEffect } from 'react';
import { useStore } from '../store';
import { InteractionPhase } from '../types';
import { fitForSlide, getSlideStepFactor } from '../utils/fitMath';

/**
 * 全局键盘 dispatcher（issue #64 #1）— 单 window keydown handler，按
 * context（isSearchOpen / isInputFocused / interactionPhase）路由到对应
 * action。替代旧的 useKeyboardShortcuts + App.jsx 双 handler 并行架构，
 * 消除 Esc 等键在多 listener 间的执行顺序不确定性。
 *
 * 路由优先级（自上而下，命中即返）：
 *   1. INPUT/TEXTAREA/contentEditable 焦点 — 不拦任何键，让浏览器原生处理
 *   2. Cmd/Ctrl+K — 开搜索面板（任何 phase 都生效）
 *   3. Esc + 搜索面板开 — 仅关搜索面板，不动 phase / selection
 *   4. Esc + 其他 — 按 phase 路由（FREE_PLACING commit / 其他 abort+deselect）
 *   5. Cmd/Ctrl + 字母 — undo/redo/copy/paste/duplicate/select all/save
 *   6. 单键 — Delete/Backspace、F、H、Enter、方向键、[/]
 *   7. Alt+H — show all
 *
 * 跟旧 useKeyboardShortcuts 的语义差异：
 *   - 加 Cmd+K → 开搜索面板（原本是 App.jsx 独立 handler）
 *   - Esc 在搜索面板开时不再误触发 abort interaction（修 race）
 *   - 其它键路由不变
 */
export function useKeyboardDispatcher() {
  const undo = useStore((state) => state.undo);
  const redo = useStore((state) => state.redo);
  const deleteSelected = useStore((state) => state.deleteSelected);
  const copySelected = useStore((state) => state.copySelected);
  const pasteClipboard = useStore((state) => state.pasteClipboard);
  const duplicateSelected = useStore((state) => state.duplicateSelected);
  const selectAll = useStore((state) => state.selectAll);
  const deselectAll = useStore((state) => state.deselectAll);
  const abortCurrentInteraction = useStore((state) => state.abortCurrentInteraction);
  const setHiddenSelected = useStore((state) => state.setHiddenSelected);
  const showAll = useStore((state) => state.showAll);

  const rotateSelectedPart = useStore((state) => state.rotateSelectedPart);
  const interactionPhase = useStore((state) => state.interactionPhase);
  const selectedPort = useStore((state) => state.selectedPort);
  const focusCameraOnSelected = useStore((state) => state.focusCameraOnSelected);
  const isSearchOpen = useStore((state) => state.isSearchOpen);
  const setSearchOpen = useStore((state) => state.setSearchOpen);

  useEffect(() => {
    /**
     * L46：AXIAL_SLIDING 步长按 FitType 缩放。Shift 仍 10× 不动；fit factor
     * 与 shift 相乘。BLOCKED / INCOMPATIBLE 返 0 锁死方向键移动。
     */
    const computeSlideStep = (shiftKey: boolean): number => {
      const baseStep = shiftKey ? 10 : 1; // LDU
      const { selectedPort, slidingTarget } = useStore.getState();
      // 缺任一端口（极端边界）→ 退化为原行为，不阻断用户
      if (!selectedPort || !slidingTarget) return baseStep;
      const fit = fitForSlide(selectedPort.portType, slidingTarget.portType);
      const factor = getSlideStepFactor(fit);
      return baseStep * factor;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // [优先级 1] 输入框焦点 — 不拦任何键
      const activeElement = document.activeElement;
      const isInputFocused =
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          (activeElement as HTMLElement).isContentEditable);
      if (isInputFocused) return;

      const cmdOrCtrl = e.metaKey || e.ctrlKey;

      // [优先级 2] Cmd/Ctrl+K — 开搜索面板（在 isInputFocused 之后处理，让
      // 搜索框自身的 input 不被打断）
      if (cmdOrCtrl && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }

      // [优先级 3] Esc + 搜索面板开 — 仅关面板，绝不下沉到 phase 处理
      if (e.key === 'Escape' && isSearchOpen) {
        e.preventDefault();
        setSearchOpen(false);
        return;
      }

      if (cmdOrCtrl) {
        // [优先级 5] Cmd/Ctrl + 字母
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) {
              redo();
            } else {
              undo();
            }
            break;
          case 'y':
            // Windows 标准 Redo: Ctrl+Y
            e.preventDefault();
            redo();
            break;
          case 'c':
            e.preventDefault();
            copySelected();
            break;
          case 'v':
            e.preventDefault();
            pasteClipboard();
            break;
          case 'd':
            e.preventDefault();
            duplicateSelected();
            break;
          case 'a':
            e.preventDefault();
            selectAll();
            break;
          case 's':
            e.preventDefault();
            // Store has persist, perhaps we just log if needed
            useStore.getState().addLog('Manual save triggered.', 'INFO');
            break;
          default:
            break;
        }
      } else {
        // [优先级 6] 单键
        switch (e.key) {
          case 'Delete':
          case 'Backspace':
            // 阻止浏览器历史后退
            if (e.key === 'Backspace') e.preventDefault();
            deleteSelected();
            break;
          case 'Escape':
            e.preventDefault();
            // [优先级 4] Esc + 搜索面板关 — 按 phase 分发。修自 issue #61
            // (Esc 路径单 dispatcher) + #64 #1（合并 App.jsx Esc handler，
            // 避免双 listener 并发）。
            if (interactionPhase === InteractionPhase.FREE_PLACING) {
              useStore.getState().commitFreePlacing(undefined);
            } else {
              abortCurrentInteraction(); // 打断当前吸附
              deselectAll(); // 以及取消所有选择
            }
            break;
          case 'h':
          case 'H':
            e.preventDefault();
            setHiddenSelected(true);
            break;
          case 'f':
          case 'F':
            e.preventDefault();
            focusCameraOnSelected();
            break;
          case 'Enter':
            if (interactionPhase === InteractionPhase.AXIAL_SLIDING) {
              e.preventDefault();
              useStore.getState().commitAxialSliding();
              useStore.getState().deselectAll();
            }
            break;
          case 'ArrowUp':
            if (interactionPhase === InteractionPhase.AXIAL_SLIDING) {
              e.preventDefault();
              const step = computeSlideStep(e.shiftKey);
              if (step !== 0) {
                const offset = useStore.getState().slideOffset;
                useStore.getState().updateSlideOffset(offset + step, e.shiftKey);
              }
            }
            break;
          case 'ArrowDown':
            if (interactionPhase === InteractionPhase.AXIAL_SLIDING) {
              e.preventDefault();
              const step = computeSlideStep(e.shiftKey);
              if (step !== 0) {
                const offset = useStore.getState().slideOffset;
                useStore.getState().updateSlideOffset(offset - step, e.shiftKey);
              }
            }
            break;
          case '[':
          case 'ArrowLeft':
            if (selectedPort &&
               (interactionPhase === InteractionPhase.SOURCE_LOCKED || interactionPhase === InteractionPhase.AXIAL_SLIDING) &&
               !selectedPort.portType.includes('axle')) {
                 e.preventDefault();
                 rotateSelectedPart(-Math.PI / 2); // 逆时针 90度
            }
            break;
          case ']':
          case 'ArrowRight':
            if (selectedPort &&
               (interactionPhase === InteractionPhase.SOURCE_LOCKED || interactionPhase === InteractionPhase.AXIAL_SLIDING) &&
               !selectedPort.portType.includes('axle')) {
                 e.preventDefault();
                 rotateSelectedPart(Math.PI / 2); // 顺时针 90度
            }
            break;
          default:
            break;
        }
      }

      // [优先级 7] Alt+H — show all
      if (e.altKey) {
        if (e.key.toLowerCase() === 'h') {
          e.preventDefault();
          showAll();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    undo,
    redo,
    deleteSelected,
    copySelected,
    pasteClipboard,
    duplicateSelected,
    selectAll,
    deselectAll,
    abortCurrentInteraction,
    setHiddenSelected,
    showAll,
    rotateSelectedPart,
    interactionPhase,
    selectedPort,
    focusCameraOnSelected,
    isSearchOpen,
    setSearchOpen,
  ]);
}

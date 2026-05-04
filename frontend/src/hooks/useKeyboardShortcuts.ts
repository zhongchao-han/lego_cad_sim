import { useEffect } from 'react';
import { useStore } from '../store';
import { InteractionPhase } from '../types';
import { fitForSlide, getSlideStepFactor } from '../utils/fitMath';

/**
 * 监听全局 CAD 标准快捷键的 Hook。
 * 包含防止与文本框冲突的防抖与隔离机制。
 */
export function useKeyboardShortcuts() {
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
      // 安全隔离：如果当前焦点在输入框或文本域内，不拦截任何 3D 快捷键
      const activeElement = document.activeElement;
      const isInputFocused =
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          (activeElement as HTMLElement).isContentEditable);

      if (isInputFocused) return;

      const cmdOrCtrl = e.metaKey || e.ctrlKey;

      if (cmdOrCtrl) {
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
        // 无组合键
        switch (e.key) {
          case 'Delete':
          case 'Backspace':
            // 阻止浏览器历史后退
            if (e.key === 'Backspace') e.preventDefault();
            deleteSelected();
            break;
          case 'Escape':
            e.preventDefault();
            abortCurrentInteraction(); // 打断当前吸附
            deselectAll(); // 以及取消所有选择
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
                useStore.getState().updateSlideOffset(offset + step);
              }
            }
            break;
          case 'ArrowDown':
            if (interactionPhase === InteractionPhase.AXIAL_SLIDING) {
              e.preventDefault();
              const step = computeSlideStep(e.shiftKey);
              if (step !== 0) {
                const offset = useStore.getState().slideOffset;
                useStore.getState().updateSlideOffset(offset - step);
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

      // Alt based shortcuts
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
    focusCameraOnSelected
  ]);
}

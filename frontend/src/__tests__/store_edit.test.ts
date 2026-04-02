import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';
import { SelectionLevel, ZoneType } from '../types';

// 劫持并 Mock window.crypto.randomUUID 保证每次生成不重复的 Mock ID
let uuidCounter = 0;
Object.defineProperty(window, 'crypto', {
  value: {
    randomUUID: () => `${++uuidCounter}0000000-mock-uuid` // 前8位包含递增数字
  }
});

describe('Store Edit Actions (Undo/Redo & Clipboard)', () => {
  beforeEach(() => {
    useStore.getState().reset();
    useStore.setState({ clipboard: [], hiddenParts: new Set() });
  });

  const setupMockParts = () => {
    useStore.setState({
      parts: {
        'P_1': { ldrawId: '3001.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 4, zone: ZoneType.ACTIVE_ARENA },
        'P_2': { ldrawId: '3002.dat', position: [1, 0, 0], quaternion: [0, 0, 0, 1], colorCode: 4, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: {
        'P_1': new Set(['P_2']),
        'P_2': new Set(['P_1']),
      },
      selection: {
        primaryId: 'P_1',
        level: SelectionLevel.GROUP,
        allConnectedIds: ['P_1', 'P_2'],
        excludedIds: []
      }
    });
  };

  it('copySelected copies selected parts to clipboard', () => {
    setupMockParts();
    useStore.getState().copySelected();
    
    const clip = useStore.getState().clipboard;
    expect(clip.length).toBe(2);
    expect(clip[0].id).toBe('P_1');
    expect(clip[1].id).toBe('P_2');
    
    // 应当是深拷贝
    expect(clip[0].state).toEqual(useStore.getState().parts['P_1']);
    expect(clip[0].state).not.toBe(useStore.getState().parts['P_1']);
  });

  it('pasteClipboard pastes parts with offsets and new ids, and can be undone', () => {
    setupMockParts();
    useStore.getState().copySelected();
    
    // 执行 Paste
    useStore.getState().pasteClipboard();
    
    const parts = useStore.getState().parts;
    const clip = useStore.getState().clipboard;
    const selection = useStore.getState().selection;

    // 总数应为 2 (原) + 2 (新) = 4
    expect(Object.keys(parts).length).toBe(4);
    
    // 验证全选焦点已移交至新组件
    expect(selection.allConnectedIds.length).toBe(2);
    expect(selection.allConnectedIds[0]).toContain('P_');
    expect(selection.allConnectedIds[0]).toContain('0000000');
    
    // 验证坐标发生了偏移 (+0.05)
    const originalPos = clip[0].state.position;
    const pastedPartId = selection.allConnectedIds[0];
    const pastedPos = parts[pastedPartId].position;
    
    expect(pastedPos[0]).toBeCloseTo(originalPos[0] + 0.05);

    // 验证可逆性 Undo
    expect(useStore.getState().canUndo).toBe(true);
    useStore.getState().undo();
    
    // 撤销后应恢复至 2 个零件
    expect(Object.keys(useStore.getState().parts).length).toBe(2);
    expect(useStore.getState().parts[pastedPartId]).toBeUndefined();
  });

  it('deleteSelected removes selected parts and their connections, and can be undone', () => {
    setupMockParts();
    
    // 删除前连接组互相绑定
    expect(useStore.getState().connections['P_1'].has('P_2')).toBe(true);

    useStore.getState().deleteSelected();

    // 验证销毁
    const parts = useStore.getState().parts;
    expect(parts['P_1']).toBeUndefined();
    expect(parts['P_2']).toBeUndefined();
    expect(Object.keys(parts).length).toBe(0);

    // 验证关联约束已被清理
    const connections = useStore.getState().connections;
    expect(connections['P_1']).toBeUndefined();

    // 验证选中集合已清空
    expect(useStore.getState().selection.allConnectedIds.length).toBe(0);

    // 回溯 (Undo)
    useStore.getState().undo();
    const restoredParts = useStore.getState().parts;
    const restoredConnections = useStore.getState().connections;

    expect(restoredParts['P_1']).toBeDefined();
    expect(restoredParts['P_2']).toBeDefined();
    // 约束必须完美复原
    expect(restoredConnections['P_1'].has('P_2')).toBe(true);
  });

  it('hide and show visibility toggles correctly', () => {
    setupMockParts();
    
    // 隐藏选中项
    useStore.getState().setHiddenSelected(true);
    expect(useStore.getState().hiddenParts.has('P_1')).toBe(true);
    expect(useStore.getState().hiddenParts.has('P_2')).toBe(true);

    // 全部显示
    useStore.getState().showAll();
    expect(useStore.getState().hiddenParts.size).toBe(0);
  });

  it('selectAll selects all visible items in the scene', () => {
    setupMockParts();
    // 取消全选
    useStore.getState().deselectAll();
    expect(useStore.getState().selection.allConnectedIds.length).toBe(0);

    // 全选
    useStore.getState().selectAll();
    expect(useStore.getState().selection.allConnectedIds.length).toBe(2);

    // 若有零件被隐藏，全选应当忽略它
    useStore.getState().setHiddenSelected(true); // P1, P2 被隐藏
    useStore.getState().deselectAll();
    
    useStore.getState().selectAll();
    expect(useStore.getState().selection.allConnectedIds.length).toBe(0); // 由于全藏，选不到
  });
});

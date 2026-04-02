import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../store';
import { SelectionLevel, InteractionPhase, ZoneType } from '../types';

beforeEach(() => {
  useStore.getState().reset();
  useStore.getState().clearLogs();
  
  // 给 crypto 打桩
  if (!globalThis.crypto) {
    globalThis.crypto = {
      randomUUID: () => 'uuid-' + Math.random().toString(36).substring(2, 9),
    } as Crypto;
  }
});

describe('Store Interactions V1.3: Multi-Select & Camera Focus', () => {

  it('selectPart(id, level, append) should aggregate selections (Toggle Add)', () => {
    // 注入虚拟零件体系
    useStore.getState().addParts(['part_A', 'part_B', 'part_C']);
    
    // 初始化点击 A
    useStore.getState().selectPart('part_A', SelectionLevel.GROUP, false);
    expect(useStore.getState().selection.allConnectedIds).toEqual(['part_A']);
    
    // 按住 Shift 连点 B
    useStore.getState().selectPart('part_B', SelectionLevel.GROUP, true);
    // 集合应当包含 A 和 B
    expect(useStore.getState().selection.allConnectedIds.includes('part_A')).toBe(true);
    expect(useStore.getState().selection.allConnectedIds.includes('part_B')).toBe(true);
    
    // 再次按住 Shift 连点 B (Toggle Off)
    useStore.getState().selectPart('part_B', SelectionLevel.GROUP, true);
    // 集合应该只剩下 A
    expect(useStore.getState().selection.allConnectedIds.includes('part_A')).toBe(true);
    expect(useStore.getState().selection.allConnectedIds.includes('part_B')).toBe(false);
  });

  it('focusCameraOnSelected() should compute centroid of all selected parts', () => {
    const store = useStore.getState();
    // 注入零件
    store.addParts(['L1', 'L2']);
    store.updatePartState('L1', { position: [-10, 0, 0] });
    store.updatePartState('L2', { position: [10, 20, 20] });
    
    // 选中 L1, L2
    store.selectPart('L1', SelectionLevel.GROUP, false);
    store.selectPart('L2', SelectionLevel.GROUP, true);
    
    // 触发相机聚焦
    store.focusCameraOnSelected();
    
    // 断言中心点坐标
    const target = useStore.getState().cameraTarget;
    expect(target).not.toBeNull();
    if (target) {
        expect(target[0]).toBe(0); // (-10 + 10) / 2
        expect(target[1]).toBe(10); // (0 + 20) / 2
        expect(target[2]).toBe(10); // (0 + 20) / 2
    }
  });

});

describe('Store Interactions V1.3: Ghost Placing (Follow Paste)', () => {
  it('pasteClipboard() should push to freePlacingPayload instead of history', () => {
    const store = useStore.getState();
    store.addParts(['org_A']);
    store.updatePartState('org_A', { position: [20, 0, 20], colorCode: 4 });
    store.selectPart('org_A');
    
    // 执行复制
    store.copySelected();
    // 执行黏贴
    store.pasteClipboard();

    const currState = useStore.getState();
    // 不该直接出现在大盘 parts 中
    expect(Object.keys(currState.parts).length).toBe(1); 
    // 相反进入了跟随区
    expect(currState.interactionPhase).toBe(InteractionPhase.FREE_PLACING);
    expect(currState.freePlacingPayload.length).toBe(1);
    
    // 此过程为了对齐世界中心，由于重心偏移，他减去了 cx 之后应该是原点 [0,0,0]
    expect(currState.freePlacingPayload[0].state.position[0]).toBe(0);
  });

  it('commitFreePlacing() should mount instances and record PASTE operation for undo', () => {
    const store = useStore.getState();
    store.addParts(['org_A']);
    store.updatePartState('org_A', { position: [8, 8, 8] });
    store.selectPart('org_A');
    store.copySelected();
    store.pasteClipboard();

    const payloadState = useStore.getState();
    const ghostId = payloadState.freePlacingPayload[0].id;
    const ghostPart = payloadState.freePlacingPayload[0].state;

    // 用户在 Scene 中确认了新位置偏移
    const finalPlacedPos = { ...ghostPart, position: [100, 100, 100] as [number,number,number] };
    
    // 触发落子
    useStore.getState().commitFreePlacing({ [ghostId]: finalPlacedPos });

    const finalState = useStore.getState();
    // 幽灵应该被清除
    expect(finalState.interactionPhase).toBe(InteractionPhase.IDLE);
    expect(finalState.freePlacingPayload.length).toBe(0);
    // 进入正式场区
    expect(finalState.parts[ghostId]).toBeDefined();
    expect(finalState.parts[ghostId].position[0]).toBe(100);

    // 能否安全撤回该克隆
    finalState.undo();
    expect(useStore.getState().parts[ghostId]).toBeUndefined();
  });

  it('commitFreePlacing(undefined) ignores the placement cleanly', () => {
    const store = useStore.getState();
    store.addParts(['org_X']);
    store.selectPart('org_X');
    store.copySelected();
    
    store.pasteClipboard();
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.FREE_PLACING);
    
    // 取消指令
    useStore.getState().commitFreePlacing(undefined);
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
    expect(useStore.getState().freePlacingPayload.length).toBe(0);
    // 本来就不应有历史污染
    expect(Object.keys(useStore.getState().parts).length).toBe(1); 
  });
});

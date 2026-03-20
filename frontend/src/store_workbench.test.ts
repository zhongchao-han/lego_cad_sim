import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import { ZoneType } from './workbench';

describe('Store: Workbench Detach Logic', () => {
  beforeEach(() => {
    // 每次测试前重置 Store 到初始状态
    // 注意：Zustand 的 SSR/测试环境重置通常需要手动或者使用 setState
    const initialState = {
      parts: {
        "32524.dat": { ldrawId: "32524.dat", position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], colorCode: 4, zone: ZoneType.ACTIVE_ARENA },
        "6558.dat":  { ldrawId: "6558.dat",  position: [0.1, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], colorCode: 0, zone: ZoneType.ACTIVE_ARENA },
      },
      connections: {
        "32524.dat": new Set(["6558.dat"]),
        "6558.dat": new Set(["32524.dat"]),
      }
    };
    useStore.setState(initialState);
  });

  it('should move a part to the first available workbench slot', () => {
    const { detachPart, workbenchGrid } = useStore.getState();
    const partId = "32524.dat";
    
    // 获取预期坐标
    const expectedPos = workbenchGrid.slots[0].worldPosition;

    detachPart(partId);

    const updatedState = useStore.getState();
    const detachedPart = updatedState.parts[partId];

    expect(detachedPart.zone).toBe(ZoneType.WORKBENCH);
    expect(detachedPart.position).toEqual(expectedPos);
    expect(detachedPart.quaternion).toEqual([0, 0, 0, 1]); // 应该被重置为水平
    
    // 验证网格逻辑层确实记录了占用
    expect(workbenchGrid.slots[0].occupiedBy).toBe(partId);
  });

  it('should clear all bidirectional connections when detached', () => {
    const partId = "32524.dat";
    const neighborId = "6558.dat";

    useStore.getState().detachPart(partId);

    const { connections } = useStore.getState();
    
    // A 自己的记录应彻底消失
    expect(connections[partId]).toBeUndefined();
    
    // B 中不应再含 A，如果 Size 为 0 则 Key 也应消失
    if (connections[neighborId]) {
       expect(connections[neighborId].has(partId)).toBe(false);
    } else {
       // 如果 B 被完全删掉，也说明 A 成功移除
       expect(connections[neighborId]).toBeUndefined();
    }
  });

  it('should not detach if workbench is full', () => {
    const { detachPart, workbenchGrid } = useStore.getState();
    
    // 强行占满所有槽位
    workbenchGrid.slots.forEach((s, i) => s.occupiedBy = `dummy_${i}`);

    const partId = "32524.dat";
    const originalPos = useStore.getState().parts[partId].position;

    detachPart(partId);

    // 应该保持原样
    const partAfter = useStore.getState().parts[partId];
    expect(partAfter.zone).toBe(ZoneType.ACTIVE_ARENA);
    expect(partAfter.position).toEqual(originalPos);
  });
});

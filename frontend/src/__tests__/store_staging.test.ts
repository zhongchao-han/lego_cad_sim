import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';
import { ZoneType } from '../types';

describe('Store: Staging Logic', () => {
  beforeEach(() => {
    // 每次测试前重置 Store 到初始状态
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
    useStore.setState(initialState as any);
    useStore.getState().stagingGrid.clearAll(); // 彻底清理暂存区，防止测试间污染
  });

  it('should move a part to the first available staging slot', () => {
    const { stagePart, stagingGrid } = useStore.getState();
    const partId = "32524.dat";
    
    // 获取预期坐标
    const expectedPos = stagingGrid.slots[0].worldPosition;

    stagePart(partId);

    const updatedState = useStore.getState();
    const stagedPart = updatedState.parts[partId];

    expect(stagedPart.zone).toBe(ZoneType.STAGED);
    expect(stagedPart.position).toEqual(expectedPos);
    expect(stagedPart.quaternion).toEqual([0, 0, 0, 1]); // 应该被重置为水平
    
    // 验证网格逻辑层确实记录了占用
    expect(stagingGrid.slots[0].occupiedBy).toBe(partId);
  });

  it('should clear all bidirectional connections when staged', () => {
    const partId = "32524.dat";
    const neighborId = "6558.dat";

    useStore.getState().stagePart(partId);

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

  it('should not stage if staging tray is full', () => {
    const { stagePart, stagingGrid } = useStore.getState();
    
    // 强行占满所有槽位
    stagingGrid.slots.forEach((s: any, i: number) => s.occupiedBy = `dummy_${i}`);

    const partId = "32524.dat";
    const originalPos = useStore.getState().parts[partId].position;

    stagePart(partId);

    // 应该保持原样
    const partAfter = useStore.getState().parts[partId];
    expect(partAfter.zone).toBe(ZoneType.ACTIVE_ARENA);
    expect(partAfter.position).toEqual(originalPos);
  });

  it('should release the slot and set zone back to ACTIVE_ARENA when snapped back', async () => {
    const { stagePart, snapParts, stagingGrid } = useStore.getState();
    const sourceId = "32524.dat";
    const targetId = "6558.dat";

    // 1. 先拆下到工作台
    stagePart(sourceId);
    expect(stagingGrid.slots[0].occupiedBy).toBe(sourceId);

    // 2. 模拟从暂存区拼回主场 (Source: 32524 从暂存区出发 -> Target: 6558 还在主场)
    const mockSource = { 
      partId: sourceId, ldrawId: sourceId, portType: 'peg', 
      position: [0, 0, 0] as [number, number, number], rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], globalPos: [0,0,0] as [number,number,number] 
    };
    const mockTarget = { 
      partId: targetId, ldrawId: targetId, portType: 'peghole', 
      position: [0, 0.02, 0] as [number, number, number], rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], globalPos: [0.1,0.02,0] as [number,number,number] 
    };

    await snapParts(mockSource as any, mockTarget as any);

    // 3. 验证闭环
    const updatedState = useStore.getState();
    expect(updatedState.parts[sourceId].zone).toBe(ZoneType.ACTIVE_ARENA);
    expect(stagingGrid.slots[0].occupiedBy).toBeNull(); // 坑位必须被腾出
  });
});

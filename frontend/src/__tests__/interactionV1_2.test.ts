import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../store'; // 假设 store 已经引入了 SelectionLevel
import { InteractionPhase, SelectionLevel } from '../types'; // 假设类型已经按规格书定义

describe('Interaction v1.2 交互测试矩阵', () => {
  beforeEach(() => {
    // 每一个测试前重置 store 状态
    useStore.getState().reset();
  });

  // --- 1. 深度钻取选择逻辑 (Drill-down Selection) ---

  it('应该支持从"组选择"到"单件钻取"的切换', () => {
    const store = useStore.getState();
    const partA = 'part_6558_0';
    const partB = 'part_32524_0';
    
    // 前提：A 和 B 是连通的
    store.addParts([partA, partB]);
    store.connectParts(partA, 'p0', partB, 'p1');

    // 动作 1：第一次点击零件 A
    store.selectPart(partA);
    expect(store.selection.primaryId).toBe(partA);
    expect(store.selection.level).toBe(SelectionLevel.GROUP);
    expect(store.selection.allConnectedIds).toContain(partB);

    // 动作 2：第二次点击同一零件 A (已选中状态下)
    store.selectPart(partA);
    expect(store.selection.primaryId).toBe(partA);
    expect(store.selection.level).toBe(SelectionLevel.INDIVIDUAL);
    // 断言：子代不再联动高亮（或虽列出但不用于整体位移）
  });

  // --- 2. 状态机生命周期 (FSM Transitions) ---

  it('应该严格遵循预期的核心阶段跳转序列', () => {
    const store = useStore.getState();
    
    expect(store.interactionPhase).toBe(InteractionPhase.IDLE);

    // 1. 从库中选取零件
    store.previewPartFromLibrary('32524');
    expect(store.interactionPhase).toBe(InteractionPhase.PREVIEWING);

    // 2. 点击锁定源端口
    store.lockSourcePort('s1', 'p1a');
    expect(store.interactionPhase).toBe(InteractionPhase.SOURCE_LOCKED);

    // 3. 点击目标端口并成功吸附 (不松开鼠标进入滑动)
    store.snapToTarget('target_part_1', 's2', 'p2');
    expect(store.interactionPhase).toBe(InteractionPhase.AXIAL_SLIDING);
    
    // 4. 松开鼠标提交
    store.commitAction();
    expect(store.interactionPhase).toBe(InteractionPhase.IDLE);
  });

  // --- 3. 操作回滚逻辑 (Abort / Esc Logic) ---

  it('在滑动深度过程中按下 Esc 应该触发强力回弹', () => {
    const store = useStore.getState();
    const originalPos = { x: 0, y: 0, z: 0 };
    
    // 进入滑动阶段并改变深度
    store.setPhase(InteractionPhase.AXIAL_SLIDING);
    store.updateSlideOffset(20.0); // 移动了 20 LDU
    
    // 模拟按下 Esc
    store.abortCurrentInteraction();
    
    // 断言：位势瞬间归零，阶段回到 IDLE
    expect(store.slideOffset).toBe(0);
    expect(store.interactionPhase).toBe(InteractionPhase.IDLE);
  });

  // --- 4. 物理反馈测试 (Interference Pulse) ---

  it('发生碰撞时应该正确触发 Blocked 状态与反馈请求', () => {
    const store = useStore.getState();
    
    // 模拟移动过程中发生碰撞
    store.setBlocked({ 
      isBlocked: true, 
      blockingPartId: 'obs_1', 
      contactPoints: [[0,0,0]] 
    });

    expect(store.interferenceReport.isBlocked).toBe(true);
    // 检查是否有关联的视觉反馈请求已记录
  });
});

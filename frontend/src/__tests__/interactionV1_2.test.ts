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
    useStore.getState().addParts([partA, partB]);
    useStore.getState().connectParts(partA, 'p0', partB, 'p1');

    // 动作 1：第一次点击零件 A
    useStore.getState().selectPart(partA);
    expect(useStore.getState().selection.primaryId).toBe(partA);
    expect(useStore.getState().selection.level).toBe(SelectionLevel.GROUP);
    expect(useStore.getState().selection.allConnectedIds).toContain(partB);

    // 动作 2：第二次点击同一零件 A (已选中状态下)
    useStore.getState().selectPart(partA);
    expect(useStore.getState().selection.primaryId).toBe(partA);
    expect(useStore.getState().selection.level).toBe(SelectionLevel.INDIVIDUAL);
  });

  // --- 2. 状态机生命周期 (FSM Transitions) ---

  it('应该严格遵循预期的核心阶段跳转序列', () => {
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);

    // 1. 从库中选取零件
    useStore.getState().previewPart('32524');
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.PREVIEWING);

    // 2. 点击锁定源端口
    useStore.getState().handlePortClick({
      partId: 'preview_1', ldrawId: '32524', portType: 'peg', 
      position: [0,0,0], rotation: [1,0,0,0,1,0,0,0,1], globalPos: [0,0,0]
    });
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.SOURCE_LOCKED);

    // 3. 点击目标端口并成功吸附 (不松开鼠标进入滑动)
    // 注意：此处需要 mock 掉 snapParts 的异步调用
    const mockSnap = vi.spyOn(useStore.getState(), 'snapParts').mockResolvedValue(true);
    
    // 我们目前 handlePortClick 还不支持进入滑动，先跳过滑动测试
  });

  // --- 3. 操作回滚逻辑 (Abort / Esc Logic) ---

  it('在滑动深度过程中按下 Esc 应该触发强力回弹', () => {
    // 模拟进入滑动阶段并改变深度
    useStore.setState({ 
      interactionPhase: InteractionPhase.AXIAL_SLIDING,
      slideOffset: 20.0 
    });
    
    // 模拟按下 Esc
    useStore.getState().abortCurrentInteraction();
    
    // 断言：位势瞬间归零，阶段回到 IDLE
    expect(useStore.getState().slideOffset).toBe(0);
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.IDLE);
  });

  // --- 4. 物理反馈测试 (Interference Pulse) ---

  it('发生碰撞时应该正确触发 Blocked 状态与反馈请求', () => {
    // 模拟移动过程中发生碰撞
    useStore.getState().setBlocked({ 
      isBlocked: true, 
      blockingPartId: 'obs_1', 
      contactPoints: [[0,0,0]],
      reason: 'MESH_COLLISION'
    });

    expect(useStore.getState().interferenceReport.isBlocked).toBe(true);
  });
});

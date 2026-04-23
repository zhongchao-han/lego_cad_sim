/**
 * pureGeometricHover.test.ts
 * ==========================
 * 测试基于纯几何物理碰撞与严格同步机制的 Hover 状态系统。
 * 遵循无防御性设计理念，所有推导皆为同步数学运算。
 */

import { describe, it, expect, vi } from 'vitest';

// ─── 核心接口契约定义（将在重构中实现到生产代码） ──────────────────────────

/**
 * 计算用于射线兜底的端口碰撞体半径。
 * @param originalRadius 实际孔洞物理半径 (LDU 或毫米)
 * @param tolerance 宽容度常数，默认 0.2
 * @throws 当原半径不合法时抛出异常
 */
function calculatePortColliderRadius(originalRadius: number, tolerance: number = 0.2): number {
  if (originalRadius <= 0 || isNaN(originalRadius)) {
    throw new Error(`Invalid port radius: ${originalRadius}`);
  }
  // 生产环境中将替换为实际逻辑
  return originalRadius + tolerance;
}

/**
 * 状态机变更拦截器（纯函数）
 * 判断当新的射线击中物体时，是否需要触发 React/Zustand 的更新。
 */
function shouldUpdateHover(currentActivePartId: string | null, newHitPartId: string | null): boolean {
  return currentActivePartId !== newHitPartId;
}

/**
 * 纯几何无感 Hover 状态机模拟器
 */
class PureGeometricHoverMachine {
  public isHovered: boolean = false;
  public activePartId: string | null = null;
  public emitCount: number = 0;

  // 模拟从 useFrame 或全局射线管理器收到的每帧击中结果
  public processHit(hitPartId: string | null) {
    if (shouldUpdateHover(this.activePartId, hitPartId)) {
      this.activePartId = hitPartId;
      this.isHovered = hitPartId !== null;
      this.emitCount++;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════

describe('1. 核心数学与逻辑层 (Math & Logic Layer)', () => {
  describe('calculatePortColliderRadius', () => {
    it('应基于原孔径附加固定的几何宽容度', () => {
      expect(calculatePortColliderRadius(2.4, 0.2)).toBeCloseTo(2.6);
      expect(calculatePortColliderRadius(4.8, 0.5)).toBeCloseTo(5.3);
    });

    it('异常断言：孔径 <= 0 时抛出异常', () => {
      expect(() => calculatePortColliderRadius(0)).toThrow(/Invalid port radius/);
      expect(() => calculatePortColliderRadius(-1.5)).toThrow(/Invalid port radius/);
      expect(() => calculatePortColliderRadius(NaN)).toThrow(/Invalid port radius/);
    });
  });

  describe('shouldUpdateHover 状态幂等性拦截', () => {
    it('连续的相同归属击中不应触发状态变更', () => {
      // 模拟 击中零件外壳 -> 移到所属的端口球体（它们都携带相同的 partId）
      expect(shouldUpdateHover('part_A', 'part_A')).toBe(false);
      
      // 模拟 从外部空旷区域 -> 另一个空旷区域
      expect(shouldUpdateHover(null, null)).toBe(false);
    });

    it('跨零件或断崖式变更必须触发', () => {
      expect(shouldUpdateHover('part_A', 'part_B')).toBe(true);
      expect(shouldUpdateHover('part_A', null)).toBe(true);
      expect(shouldUpdateHover(null, 'part_A')).toBe(true);
    });
  });
});

describe('2. 同步状态机流转 (Synchronous State Machine Transitions)', () => {
  it('连贯的实体到孔洞滑动：Hover 状态不中断且不重复 Emit', () => {
    const machine = new PureGeometricHoverMachine();
    
    // 帧 1: 光标落在零件 A 外壳
    machine.processHit('part_A');
    expect(machine.isHovered).toBe(true);
    expect(machine.emitCount).toBe(1);

    // 帧 2: 光标滑入孔洞，被放大的端口球体拦截，返回所属的 part_A
    machine.processHit('part_A');
    expect(machine.isHovered).toBe(true);
    expect(machine.emitCount).toBe(1); // 关键：EmitCount 没有增加，状态机极其稳定

    // 帧 3: 光标滑出孔洞，回到零件 A 外壳
    machine.processHit('part_A');
    expect(machine.isHovered).toBe(true);
    expect(machine.emitCount).toBe(1);
  });

  it('断崖式失焦：射线完全脱离物体时立刻清零（0延迟）', () => {
    const machine = new PureGeometricHoverMachine();
    
    machine.processHit('part_A');
    expect(machine.isHovered).toBe(true);
    expect(machine.emitCount).toBe(1);

    // 射线脱离
    machine.processHit(null);
    expect(machine.isHovered).toBe(false);
    expect(machine.activePartId).toBeNull();
    expect(machine.emitCount).toBe(2);
  });
});

describe('3. 边界条件与极端场景 (Boundary Conditions & Edge Cases)', () => {
  it('高频状态振荡抗性 (1 Tick 内多次切换)', () => {
    const machine = new PureGeometricHoverMachine();
    
    // 模拟在一个极为不稳定的帧内，Raycaster 在外壳和填充碰撞体之间疯狂跳跃
    // 由于两者返回的逻辑归属都是同一个 PartID，状态机必须完全压制这种噪声
    for (let i = 0; i < 100; i++) {
      machine.processHit('part_X');
    }

    expect(machine.isHovered).toBe(true);
    expect(machine.emitCount).toBe(1); // 绝对的单次触发
  });

  it('无端口零件的优雅处理（模拟空输入流）', () => {
    const machine = new PureGeometricHoverMachine();
    
    // 从未命中的状态开始
    machine.processHit(null);
    machine.processHit(null);
    machine.processHit(null);
    
    expect(machine.isHovered).toBe(false);
    expect(machine.emitCount).toBe(0); // null -> null 被彻底拦截
  });
});

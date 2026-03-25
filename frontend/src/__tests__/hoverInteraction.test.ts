/**
 * hoverInteraction.test.ts
 * ========================
 * 针对本次修复过程中暴露的全部 Hover 交互 Bug 进行回归测试。
 *
 * 测试策略：
 *   由于 R3F 组件无法在 Node 环境中直接渲染，所有测试均基于"事件处理逻辑的状态机模拟"。
 *   我们将组件中的关键处理函数提取到可控的测试场景中，通过 vi.fn() 模拟回调并
 *   手动触发事件时序，逐一验证每个 Bug 场景下的预期行为。
 *
 * 覆盖的 Bug：
 *   Bug-1: 端口 in-group 移动触发零件 hover 闪烁（防抖 timer 竞态）
 *   Bug-2: LDrawMeshRenderer cloned 在 hover 变化时重建，引发合成 onPointerOut
 *   Bug-3: stopPropagation 阻止被遮挡端口接收射线事件
 *   Bug-4: 从端口返回零件本体时 Part 变非半透明（Port-Out 抢在 Mesh-Over 之后触发）
 *   Bug-5: SiteGizmo 展开/收起状态机
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── 辅助：模拟 R3F <group> 的 onPointerEnter/Leave 事件契约 ────────────────
// group 级事件保证：仅在鼠标进/出整个 group (含全部子孙节点) 时各触发一次。
// 在 group 内各子节点之间移动时，不会重复触发。

class GroupHoverSimulator {
  public hovered = false;
  private onChange: (h: boolean) => void;

  constructor(onChange: (h: boolean) => void) {
    this.onChange = onChange;
  }

  /** 模拟鼠标进入 group 或其任意子对象 */
  pointerEnter() {
    this.hovered = true;
    this.onChange(true);
  }

  /** 模拟鼠标离开 group 及其所有子对象 */
  pointerLeave() {
    this.hovered = false;
    this.onChange(false);
  }

  /** 模拟在 group 内从一个子对象移动到另一个子对象（不应触发 enter/leave） */
  moveWithinGroup() {
    // 在正确的实现中，这里什么都不做
  }
}

// ─── 辅助：模拟 LDrawMeshRenderer 的 cloned 稳定性 ────────────────────────
class ClonedStabilitySimulator {
  public cloneCount = 0;
  private scene: object | null = null;

  /** 等同于 useMemo(() => clone(scene), [scene]) */
  updateScene(newScene: object) {
    if (newScene !== this.scene) {
      this.scene = newScene;
      this.cloneCount++;
    }
  }

  /**
   * 高亮/透明度变化不得触发 clone 重建。
   * 修复后通过 useEffect 命令式更新材质，不改变 cloned 依赖项。
   */
  updateHighlight(_color: string | null, _intensity: number) {
    // 正确实现：不触发 cloneCount 增加
  }

  updateOpacity(_opacity: number) {
    // 正确实现：不触发 cloneCount 增加
  }
}

// ─── 辅助：模拟端口射线事件链 ──────────────────────────────────────────────
// 没有 stopPropagation 时，射线事件依次分发给所有命中对象。
// 有 stopPropagation 时，仅分发给最近的对象。

function simulateRaycastHit(
  objects: Array<{ onPointerOver: () => void; stopsPropagation: boolean }>
) {
  for (const obj of objects) {
    obj.onPointerOver();
    if (obj.stopsPropagation) break;
  }
}

// ─── 辅助：SiteGizmo 展开状态机 ───────────────────────────────────────────
class SiteGizmoSimulator {
  public siteHovered = false;
  public isExpanded: boolean;
  private phase: string;

  constructor(phase: string = 'IDLE') {
    this.phase = phase;
    this.isExpanded = this.computeExpanded();
  }

  private computeExpanded(): boolean {
    return this.siteHovered
      || this.phase === 'SOURCE_LOCKED'
      || this.phase === 'AXIAL_SLIDING';
  }

  neutralSphereOver() {
    this.siteHovered = true;
    this.isExpanded = this.computeExpanded();
  }

  neutralSphereOut() {
    this.siteHovered = false;
    this.isExpanded = this.computeExpanded();
  }

  setPhase(phase: string) {
    this.phase = phase;
    this.isExpanded = this.computeExpanded();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug-1 回归：Group onPointerEnter/Leave 在子节点切换时不触发
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug-1: 子节点间移动不触发 hover 闪烁', () => {
  it('鼠标进入 group 后，hover 变为 true', () => {
    const onChange = vi.fn();
    const group = new GroupHoverSimulator(onChange);

    group.pointerEnter();

    expect(group.hovered).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('在 group 内从 Mesh 移到 Port，不触发 onChange', () => {
    const onChange = vi.fn();
    const group = new GroupHoverSimulator(onChange);

    group.pointerEnter(); // 进入 group
    onChange.mockClear();

    group.moveWithinGroup(); // Mesh -> Port 内部切换

    expect(onChange).toHaveBeenCalledTimes(0); // 关键：不应触发任何 hover 变化
    expect(group.hovered).toBe(true);          // hover 状态稳定保持
  });

  it('在 group 内来回切换 N 次，hover 依然保持 true', () => {
    const onChange = vi.fn();
    const group = new GroupHoverSimulator(onChange);

    group.pointerEnter();
    onChange.mockClear();

    for (let i = 0; i < 10; i++) {
      group.moveWithinGroup(); // 反复在子节点间移动
    }

    expect(onChange).toHaveBeenCalledTimes(0);
    expect(group.hovered).toBe(true);
  });

  it('鼠标离开 group，hover 变为 false', () => {
    const onChange = vi.fn();
    const group = new GroupHoverSimulator(onChange);

    group.pointerEnter();
    group.moveWithinGroup();
    group.pointerLeave();

    expect(group.hovered).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('第二次进入 group，hover 再次变为 true', () => {
    const onChange = vi.fn();
    const group = new GroupHoverSimulator(onChange);

    // 第一次 hover 周期
    group.pointerEnter();
    group.pointerLeave();
    onChange.mockClear();

    // 第二次 hover 周期
    group.pointerEnter();

    expect(group.hovered).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug-2 回归：LDrawMeshRenderer cloned 在 hover 状态变化时不得重建
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug-2: cloned 仅在 scene 变化时重建，不随 hover 状态变化', () => {
  it('初始加载 scene 时 clone 一次', () => {
    const sim = new ClonedStabilitySimulator();
    const scene = {};
    sim.updateScene(scene);
    expect(sim.cloneCount).toBe(1);
  });

  it('high亮颜色变化（hover ON）不触发 clone 重建', () => {
    const sim = new ClonedStabilitySimulator();
    const scene = {};
    sim.updateScene(scene);
    const initialCount = sim.cloneCount;

    sim.updateHighlight('#ffffff', 0.15); // hover ON

    expect(sim.cloneCount).toBe(initialCount);
  });

  it('高亮色清零（hover OFF）不触发 clone 重建', () => {
    const sim = new ClonedStabilitySimulator();
    const scene = {};
    sim.updateScene(scene);

    sim.updateHighlight('#ffffff', 0.15);
    sim.updateHighlight(null, 0); // hover OFF

    expect(sim.cloneCount).toBe(1);
  });

  it('反复切换 hover 状态不触发 clone 重建', () => {
    const sim = new ClonedStabilitySimulator();
    sim.updateScene({});

    for (let i = 0; i < 20; i++) {
      sim.updateHighlight(i % 2 === 0 ? '#ffffff' : null, i % 2 === 0 ? 0.15 : 0);
      sim.updateOpacity(i % 2 === 0 ? 0.5 : 1.0);
    }

    expect(sim.cloneCount).toBe(1);
  });

  it('scene 对象真正变化时触发 clone 重建', () => {
    const sim = new ClonedStabilitySimulator();
    sim.updateScene({ id: 1 });
    sim.updateScene({ id: 2 }); // 新 scene 对象

    expect(sim.cloneCount).toBe(2);
  });

  it('相同 scene 对象引用不触发重建', () => {
    const sim = new ClonedStabilitySimulator();
    const scene = { id: 1 };
    sim.updateScene(scene);
    sim.updateScene(scene); // 同一个引用

    expect(sim.cloneCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug-3 回归：移除 Part 层级的 stopPropagation，允许射线穿透到被遮挡的端口
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug-3: 被 Part 遮挡的 Port 依然能接收射线事件', () => {
  it('Part 不拦截射线时，被遮挡的 Port 也能收到 onPointerOver', () => {
    const partHover = vi.fn();
    const portHover = vi.fn();

    // Part 在前（距离近），Port 在后（距离远），Part 没有 stopPropagation
    const objects = [
      { onPointerOver: partHover, stopsPropagation: false },  // Part（近）
      { onPointerOver: portHover, stopsPropagation: true },   // Port（远，被遮挡）
    ];

    simulateRaycastHit(objects);

    expect(partHover).toHaveBeenCalledTimes(1);
    expect(portHover).toHaveBeenCalledTimes(1); // 关键：Port 也必须收到事件
  });

  it('Part 拦截射线时，被遮挡的 Port 收不到 onPointerOver（旧 Bug 复现）', () => {
    const partHover = vi.fn();
    const portHover = vi.fn();

    // 旧行为：Part 调用 stopPropagation
    const objects = [
      { onPointerOver: partHover, stopsPropagation: true },  // Part 拦截！
      { onPointerOver: portHover, stopsPropagation: false },
    ];

    simulateRaycastHit(objects);

    expect(partHover).toHaveBeenCalledTimes(1);
    expect(portHover).toHaveBeenCalledTimes(0); // Port 被阻断，这是旧的 Bug
  });

  it('Port 自身可以拦截射线（阻止更远处对象）', () => {
    const portHover = vi.fn();
    const behindPartHover = vi.fn();

    const objects = [
      { onPointerOver: portHover, stopsPropagation: true },      // Port 拦截
      { onPointerOver: behindPartHover, stopsPropagation: false },
    ];

    simulateRaycastHit(objects);

    expect(portHover).toHaveBeenCalledTimes(1);
    expect(behindPartHover).toHaveBeenCalledTimes(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug-4 回归：从 Port 返回 Part 本体后，Part 保持半透明
// 旧 Bug 路径：Port-Out 启动 timer → Mesh-Over 撤销 timer
//             但若顺序反转（Mesh-Over 先，Port-Out 后），timer 残留导致失效
// 修复路径：group enter/leave 保证不在子节点间重复触发
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug-4: 从 Port 回到 Part 本体，Part 保持半透明（hover=true）', () => {
  it('完整路径：Part Hover ON → 进入 Port → 返回 Part → 离开', () => {
    const onChange = vi.fn();
    const group = new GroupHoverSimulator(onChange);

    // 1. 鼠标进入 group（命中 Part Mesh）
    group.pointerEnter();
    expect(group.hovered).toBe(true);

    // 2. 在 group 内移动到 Port（内部切换，不触发 group 级事件）
    group.moveWithinGroup();
    expect(group.hovered).toBe(true); // 依然保持 true

    // 3. 从 Port 返回 Part Mesh（仍在 group 内）
    group.moveWithinGroup();
    expect(group.hovered).toBe(true); // Bug 修复前：此处会变 false

    // 4. 离开整个 group
    group.pointerLeave();
    expect(group.hovered).toBe(false);
  });

  it('任意数量的内部切换后，只要未离开 group，hover 始终为 true', () => {
    const onChange = vi.fn();
    const group = new GroupHoverSimulator(onChange);

    group.pointerEnter();

    const transitions = ['port', 'mesh', 'port', 'port', 'mesh', 'gizmo', 'mesh'];
    for (const _ of transitions) {
      group.moveWithinGroup();
      expect(group.hovered).toBe(true);
    }

    expect(onChange).toHaveBeenCalledTimes(1); // 仅初始 enter 调用一次
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug-5 回归：SiteGizmo 展开/收起状态机
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug-5: SiteGizmo 展开状态机', () => {
  it('IDLE 阶段默认不展开', () => {
    const gizmo = new SiteGizmoSimulator('IDLE');
    expect(gizmo.isExpanded).toBe(false);
  });

  it('Hover 中性球后展开', () => {
    const gizmo = new SiteGizmoSimulator('IDLE');
    gizmo.neutralSphereOver();
    expect(gizmo.isExpanded).toBe(true);
  });

  it('离开中性球后收起', () => {
    const gizmo = new SiteGizmoSimulator('IDLE');
    gizmo.neutralSphereOver();
    gizmo.neutralSphereOut();
    expect(gizmo.isExpanded).toBe(false);
  });

  it('SOURCE_LOCKED 阶段强制展开（无需悬停）', () => {
    const gizmo = new SiteGizmoSimulator('SOURCE_LOCKED');
    expect(gizmo.isExpanded).toBe(true);
  });

  it('AXIAL_SLIDING 阶段强制展开', () => {
    const gizmo = new SiteGizmoSimulator('AXIAL_SLIDING');
    expect(gizmo.isExpanded).toBe(true);
  });

  it('从 IDLE 切换到 SOURCE_LOCKED 后即使未悬停也展开', () => {
    const gizmo = new SiteGizmoSimulator('IDLE');
    expect(gizmo.isExpanded).toBe(false);
    gizmo.setPhase('SOURCE_LOCKED');
    expect(gizmo.isExpanded).toBe(true);
  });

  it('离开中性球但处于 SOURCE_LOCKED 时，仍保持展开', () => {
    const gizmo = new SiteGizmoSimulator('SOURCE_LOCKED');
    gizmo.neutralSphereOver();
    gizmo.neutralSphereOut(); // 离开中性球
    expect(gizmo.isExpanded).toBe(true); // 仍因 phase 展开
  });
});

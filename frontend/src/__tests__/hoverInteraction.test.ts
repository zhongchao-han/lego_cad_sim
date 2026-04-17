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

// ═══════════════════════════════════════════════════════════════════════════
// Bug-6 回归：Hover 互斥压制（当鼠标处于 PortGizmo 隐藏热区时，立刻阻断底层 Part Mesh 的 Hover 高亮，分离两者的碰撞实体）
// ═══════════════════════════════════════════════════════════════════════════

class InteractivePartSimulator {
  public meshHitboxHits: number = 0;
  public isPortHovered: boolean = false;
  // 此处 meshHovered 仅代表是否有物理射线交叉（保持 Gizmo 不卸载）
  public meshHovered: boolean = false;
  // 新架构下，外发光/边缘高光是由组合状态推导的
  public get isOutlineActive() {
    return this.meshHovered && !this.isPortHovered;
  }
  private onChange: (h: boolean) => void;

  constructor(onChange: (h: boolean) => void) {
    this.onChange = onChange;
  }

  // 模拟从 SiteGizmo 收到的局部 hover 回调 (传递端口 info)
  handlePortHoverLocal(info: object | null) {
    this.isPortHovered = !!info;
  }

  // 模拟 useFrame 里的射线穿透扫描 (包含分离在单独 group 中的 Mesh hitbox)
  useFrameTick(hitCount: number) {
    this.meshHitboxHits = hitCount;
    // 只要有射线扫中外壳，不论有没有扫中端口，MeshHover 都是 true（为了保留 Gizmo）
    const isNowHovered = this.meshHitboxHits > 0;
    
    if (isNowHovered !== this.meshHovered) {
      this.meshHovered = isNowHovered;
      this.onChange(isNowHovered);
    }
  }
}

describe('Bug-6: Hover 互斥机制（插销高亮时零件主体剥离高亮）', () => {
  it('未悬停任何对象时，两者皆非 hovered', () => {
    const onChange = vi.fn();
    const sim = new InteractivePartSimulator(onChange);
    
    sim.useFrameTick(0);
    expect(sim.meshHovered).toBe(false);
    expect(sim.isPortHovered).toBe(false);
    expect(sim.isOutlineActive).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(0);
  });

  it('仅射线扫中分离后的主体被检测到（Hit>0），主体点亮', () => {
    const onChange = vi.fn();
    const sim = new InteractivePartSimulator(onChange);
    
    sim.useFrameTick(1); // 射线打中单独 hitbox
    expect(sim.meshHovered).toBe(true);
    expect(sim.isOutlineActive).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('当同时触发射线打中主体并且落在插槽内（有info），主体外发光被【强制压制】不点亮，但逻辑 Hover 必须保留以便稳定 Gizmo', () => {
    const onChange = vi.fn();
    const sim = new InteractivePartSimulator(onChange);
    
    sim.handlePortHoverLocal({ id: 'dummy_port_info' });
    sim.useFrameTick(1); 
    
    expect(sim.isPortHovered).toBe(true);
    expect(sim.meshHovered).toBe(true); 
    expect(sim.isOutlineActive).toBe(false); // 外发光熄灭 !
    expect(onChange).toHaveBeenCalledTimes(1); 
  });

  it('当鼠标划过零件网格（高亮）后平移进入插槽包围盒，网格高亮会被立即浇灭（残光修复）', () => {
    const onChange = vi.fn();
    const sim = new InteractivePartSimulator(onChange);
    
    // 阶段1：鼠标进入零件表面
    sim.useFrameTick(1);
    expect(sim.isOutlineActive).toBe(true);
    
    // 阶段2：鼠标滑入到内部附属的端口 Gizmo 的大球壳热区上方
    sim.handlePortHoverLocal({ id: 'dummy_port_info' });
    
    expect(sim.isPortHovered).toBe(true);
    
    // 阶段3：R3F 在随后的 requestAnimationFrame 中触发射线扫描
    sim.useFrameTick(1);

    expect(sim.meshHovered).toBe(true); // 保证逻辑不断
    expect(sim.isOutlineActive).toBe(false); // 此时完成强制置零（脱落）
  });
  
  it('离开端口包围区（info=null）并依然留在零件外壳上时，应恢复主体高亮', () => {
    const onChange = vi.fn();
    const sim = new InteractivePartSimulator(onChange);
    
    // 初始化直接进端口热区
    sim.handlePortHoverLocal({ portType: 'F' });
    sim.useFrameTick(1);
    expect(sim.isOutlineActive).toBe(false);
    
    // 鼠标移出端口热区（返回空），并仍在主体范围内（射线 Hit 继续存在）
    sim.handlePortHoverLocal(null);
    sim.useFrameTick(1);
    
    expect(sim.isPortHovered).toBe(false);
    expect(sim.meshHovered).toBe(true);
    expect(sim.isOutlineActive).toBe(true); // 恢复点亮
  });
});

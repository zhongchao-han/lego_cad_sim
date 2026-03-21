# 技术规格书：Interaction v1.2 宏观类与接口定义

本规格书定义了系统在 Interaction v1.2 阶段的核心数据结构、逻辑控制类以及前端状态机契约。

---

## 1. 拓扑数据模型 (Topology Model)

我们将零件的端口从“扁平列表”升级为“场站（Site）”架构，以解决同心孔冲突。

### 1.1 `Site` (物理场站)
代表零件上一个固定的物理坑位（如一个 1x1 的圆孔）。
```typescript
interface Site {
  readonly id: string;           // 局部唯一 ID
  readonly position: Vec3;       // 在零件局部空间的位置中心
  readonly type: SiteType;       // HOLE, CROSS_HOLE, STUD...
  readonly ports: Port[];        // 从该坑位延伸出的所有可选交互端口
  occupiedBy: string | null;     // 物理占用标记（Instance ID）
}
```

### 1.2 `Port` (交互端口)
代表从 Site 延伸出的特定方向、特定类型的连接意图。
```typescript
interface Port {
  readonly id: string;           // 局部唯一 ID (如 "side_a")
  readonly parentSiteId: string; // 回溯所属 Site
  readonly direction: Vec3;      // 插入方向法向量 (Normal)
  readonly gender: 'MALE' | 'FEMALE';
  readonly profile: 'CYLINDER' | 'CROSS' | 'STUD';
}
```

---

## 2. 交互状态机 (Interaction FSM)

严格定义用户操作的生命周期，确保“滑动”与“选择”不冲突。

### 2.1 `InteractionPhase` (交互阶段)
```typescript
enum InteractionPhase {
  IDLE,               // 空闲：常规选择与相机漫游
  PREVIEWING,         // 预览：从库中拿起零件，悬停寻找 Site
  SOURCE_LOCKED,      // 锚定：已选定 Source，等待 Target 闭合
  AXIAL_SLIDING,      // 滑动：Snap 已完成，但在 MouseUp 前进行深度调节
  ANIMATING_SNAP,     // 动画：系统正在自动补间落位
}
```

---

## 3. 逻辑控制器 (Logic Controllers)

### 3.1 `ConstraintSolver` (物理约束解析器)
计算当前连接状态下的剩余自由度 (DOF)。
```typescript
class ConstraintSolver {
  /** 根据连接列表计算零件的自由度状态 */
  static solveDOF(partId: string, connections: Connection[]): DOFReport;
}

interface DOFReport {
  canRotate: boolean;       // 是否支持绕连接轴旋转
  canSlide: boolean;        // 是否支持沿轴线滑动
  axis: Vec3 | null;        // 活动轴线
  angleStep: number;        // 旋转步进 (90, 45, or 1)
  slideRange: [number, number]; // 允许的滑动深度区间 [min, max]
}
```

### 3.2 `FitEngine` (配合度引擎)
根据物理截面形状决定连接性质。
```typescript
enum FitType {
  CLEARANCE, // 间隙配合（可自由转动、滑动）
  FRICTION,  // 过盈/摩擦配合（具有阻尼感的旋转/滑动）
  BLOCKED,   // 几何干涉（无法插入）
}

class FitEngine {
  /** 核心判定逻辑：根据 Profile 和尺寸计算配合度 */
  static check(plug: Port, socket: Port): FitType;
}

### 3.3 `CollisionEngine` (阻连与干涉引擎)
负责实时几何干涉计算与位移“钳位” (Clamping)。
```typescript
interface InterferenceReport {
  isBlocked: boolean;
  blockingPartId: string | null;  // 撞到了哪个零件
  contactPoints: Vec3[];          // 具体的几何干涉点坐标（用于红色脉冲高亮）
  reason: 'MESH_COLLISION' | 'STOP_FEATURE' | 'OVER_CONSTRAINED';
}

class CollisionEngine {
  /** 沿移动向量测试是否会发生物理阻连 */
  static testMotion(part: SelectionAnchor, delta: Vec3): InterferenceReport;
  
  /** 反向计算允许的最大滑动/旋转偏移量极限 (Clamp Value) */
  static calculateLimit(part: SelectionAnchor, axis: Vec3): [number, number];
}
```

### 3.4 `FeedbackManager` (视觉与交互反馈)
驱动全场景的报错视图、脉冲动画与 HUD 提示系统。
```typescript
class FeedbackManager {
  /** 在 3D 空间触发干涉点的红色脉冲 (Red Pulse) */
  static pulseCollision(points: Vec3[]): void;
  
  /** 触发视觉/听觉上的机械撞击感 (Micro-Shake / Click) */
  static triggerHitFeedback(): void;

  /** 在 UI 层显示浮动的故障诊断提示 (HUD Blocking Tip) */
  static showBlockingHint(report: InterferenceReport): void;
}
```

### 3.5 `GizmoManager` (视觉辅助管理器)
负责在 3D 空间动态渲染方向选择箭头。
```typescript
class GizmoManager {
  /** 为特定 Site 渲染方向箭头组 */
  static showDirectionArrows(site: Site): void;
  
  /** 选中某个箭头，返回确定的 Port 意图 */
  static pickPortFromArrow(arrowId: string): Port;
}
```
```

---

## 4. 动力学与动画轨道 (Animation & Kinematics)

### 4.1 `AnimationState` (补间轨道)
所有非瞬间位移必须通过此轨道进行渲染。
```typescript
interface AnimationTrack {
  readonly start: Pose;
  readonly end: Pose;
  readonly duration: number; 
  progress: number; // 0 -> 1
  easing: (t: number) => number;
  onComplete?: () => void;
}

interface Pose {
  position: Vec3;
  quaternion: Quat;
}
```

### 4.2 `ConnectionEdge` (拓扑连接边)
代表两个零件之间的物理链接。
```typescript
interface ConnectionEdge {
  readonly id: string;
  readonly partA: string;      // Source
  readonly partB: string;      // Target
  readonly portA: string;      // Source Port ID
  readonly portB: string;      // Target Port ID
  depthOffset: number;         // 沿轴滑动的偏移量 d
  rotationOffset: number;      // 围绕轴旋转的偏移量 angle (弧度)
}
```

---

## 5. 关键交互契约 (Interaction Contracts)

### 4.1 锚点组选与钻取逻辑 (Anchor & Drill-down Selection)
```typescript
enum SelectionLevel {
  GROUP = 'GROUP',           // 默认等级：选中物理连通组
  INDIVIDUAL = 'INDIVIDUAL', // 钻取等级：仅选中光标下的单个零件
}

interface SelectionAnchor {
  primaryId: string;          // 当前选中的核心零件
  level: SelectionLevel;      // 选择深度 (默认为 GROUP)
  allConnectedIds: string[];  // 物理连通组内所有零件 (仅在 GROUP 级别用于位移同步)
  excludedIds: string[];      // 被排除的零件
}
```

### 4.2 地基锚定属性 (Scene Grounding)
为解决装配体在调节时“满屏乱飞”的问题，系统支持将任意零件锁定到场景坐标系。
```typescript
interface PartNode {
  readonly id: string;
  isGrounded: boolean;        // 核心属性：是否锚定到场景（固定点）
  // ... 其他位姿属性
}
```

### 4.3 滑动定深契约 (The Slide Contract)
- **触发条件**: `InteractionPhase === AXIAL_SLIDING` 且 `MouseButton === DOWN`。
- **输入**: 鼠标在屏幕上的屏幕位移 $\Delta Y$。
- **运动学规则 (Kinematic Inheritance)**: 
  - 只有在当前装配树中，属于被滑动零件的 **子代节点 (Descendants)** 会跟随产生位移。
  - 父节点与非支路零件保持不动。
- **提交**: `MouseUp` 时，将最终 $d$ 封装进 `ActionCommand` 提交给 HistoryStack。

### 5.3 极限场景处理策略 (Edge Case Handling)

为了确保物理系统的严密性，系统在以下三个场景下执行特定逻辑：

#### A. 物理孤岛检测 (Island Detection & Split)
- **场景**：用户删除、移动或抽取装配体中的关键连接件。
- **逻辑**：一旦拓扑图断裂，系统自动通过广度优先搜索 (BFS) 重新扫描整个场景图。
- **行为**：将原本的装配体（Group）拆分为多个独立的 **物理岛屿 (Sub-islands)**。每个岛屿在移动或 Staging 时作为一个整体受控。

#### B. 主从多点吸附 (Primary-Secondary Latching)
- **场景**：零件有两个以上平行端口需同时 Snap（如多孔梁、导轨）。
- **流程**：用户通过 3D Gizmo 箭头锁定一对 **Primary Port** 进行对齐。
- **自动闭合**：在对齐完成或滑动调节过程中，系统实时扫描（<1mm 阈值）附近的全部有效端口，并自动生成后置连接边（Latching）。

#### C. 操作回滚与撤销 (Abort & Undo Path)
- **撤销 (Undo/Redo)**：仅在 `MouseUp` 或 `Commit` 确定状态后记录最终变更。
- **回滚 (Abort/Esc)**：在任何非 IDLE 阶段按 `Esc` 键，系统立即丢弃位移快照，零件 **瞬间强力弹回 (Snap Back)** 到操作前位置，且不留下历史痕迹。

---

## 6. 后端同步规范 (Backend Sync)

后端 `analyze_ports.py` 在导出零件元数据时，必须遵循以下标准：
- **聚合算法**: 凡是 `distance(pos_a, pos_b) < 1.0 LDU` 的端口，必须归并到同一个 `Site` 对象中。
- **维度确认**: 归并后的 `Site.pos` 应为各端口坐标的几何中心。

---

<negative_constraints>
- **禁止在 Site 内部维护复杂的物理引擎实例**：Site 应保持为纯数据描述层。
- **禁止硬编码自由度**：所有的旋转/滑动限制必须由 `ConstraintSolver` 结合端口类型实时推导。
</negative_constraints>

---

## 6. 数据存储映射 (JSON Schema)

后端 `analyze_ports.py` 导出的 `ldraw_port_configs.json` 必须符合以下聚合结构：

```json
{
  "part_filename.dat": {
    "sites": [
      {
        "site_id": "s0",
        "pos": [0, 20, 0],
        "type": "peghole",
        "ports": [
          { "id": "p0", "dir": [0, 1, 0], "gender": "FEMALE", "profile": "CYLINDER" },
          { "id": "p1", "dir": [0, -1, 0], "gender": "FEMALE", "profile": "CYLINDER" }
        ]
      }
    ]
  }
}
```

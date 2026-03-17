# 交互流与操作历史设计文档：状态机、动画与命令模式

> **To Claude Code CLI:**
> Please read the following files into your context immediately to establish a stable context prefix for Prompt Caching:
> 
> Required context files:
> - `frontend/src/store.ts` (前端状态机与操作流核心)
> - `topology_manager.py` (后端多点闭环扫描逻辑扩展点)

<directory_structure>
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
├───topology_manager.py      # 待扩展：新增多点自动闭环扫描 (Auto-Snap Scanner)
└───frontend/src/
    └───store.ts             # 待扩展：新增 FSM, AnimationTrack, Undo/Redo
</directory_structure>

<current_pain_points>
在产品文档和 `assembly_interaction_system_design.md` 中定义了极具物理感的“交互灵魂”（如焦点预览、退位动画、步进拆解、撤销栈）。但目前的 `store.ts` 仅维护了静态的“零件位置”和“连接关系”，完全缺乏对“操作流（Flow）”和“时间切片（History）”的抽象：
1. **组装流状态含糊**：仅凭 `selectedPort` 无法严谨表达用户是处于“游场模式”还是“锁定源端口准备落位”的阶段。
2. **缺乏动画载体**：改变位置是瞬间完成的，没有抽象出 `AnimationState` 来支撑文档中要求的“滑入动画”和“物理退位动画”。
3. **拆解意图无法解析**：没有区分双击事件中射线击中的是哪一侧零件，导致无法实现“点谁谁走”。
4. **无 Undo/Redo 栈**：销毁、暂存、连接动作没有被封装为命令模式（Command），一旦误操作无法回退。
5. **多点盲区**：单次 Snap 结束后，系统不会自动扫描邻近 `<1mm` 的端口去形成闭环，导致刚体图约束不完整。
</current_pain_points>

<core_design_rules>
### 1. 交互状态机 (Interaction FSM)
前端必须引入显式的阶段枚举（`InteractionPhase`），严格控制鼠标点击事件在不同阶段下的响应逻辑，避免状态冲突。

### 2. 命令模式与历史栈 (Command Pattern & History)
所有改变拓扑和场景状态的操作（Snap、拆解、移入暂存区、回收）必须封装为 `ActionCommand`。Store 需要维护 `past` 和 `future` 两个队列，并提供基于最小差异快照（Diff Snapshot）的撤销/重做能力。

### 3. 补间动画管理器 (Animation Track)
改变零件位姿（从预览进入画布，或从约束中拆解退位）不应直接暴力赋值目标矩阵，而应向实例注入 `AnimationState`，在 Three.js 的 `useFrame` 循环中消费该状态，播放完毕后再正式确立物理连接。

### 4. 拆解主动侧判定 (Active Side Detachment)
双击事件必须附带命中侧（Hit Side）和对向侧（Opposite Side）信息。被命中侧被标记为“主动侧”（移出），对向侧为“锚定侧”（不动）。

### 5. 自动闭环扫描 (Auto-Snap Scanner)
完成主 Snap 动作（以及其动画）后，触发一个钩子：扫描移动组（Moved Group）内的所有未连接端口，寻找与锚定组（Anchored Group）内距离小于 1mm（~2.5 LDU）的合法端口，自动生成新的 `ConnectionEdge`（闭环）。
</core_design_rules>

<architecture>
## 数据结构与接口定义建议

### 【前端】1. 交互流状态机
```typescript
export enum InteractionPhase {
  IDLE = 'IDLE',                       // 空闲/游场模式
  PREVIEW_INSPECT = 'PREVIEW_INSPECT', // 预览物料，寻找起始端口
  SOURCE_LOCKED = 'SOURCE_LOCKED',     // 已锁定源端口，寻找主画布目标端口
  ANIMATING_SNAP = 'ANIMATING_SNAP',   // 正在播放滑入动画（锁定用户输入）
}

interface InteractionState {
  currentPhase: InteractionPhase;
  sourceLockData: SelectedPortInfo | null;
  transitionTo: (nextPhase: InteractionPhase) => void;
}
```

### 【前端】2. 动画插值控制
```typescript
interface AnimationState {
  isAnimating: boolean;
  startPosition: Vec3;
  targetPosition: Vec3;
  startQuaternion: Quat;
  targetQuaternion: Quat;
  progress: number;        // 0.0 -> 1.0
  onComplete?: () => void; // 动画结束后的拓扑提交回调
}

// 扩展现有的 LegoPartInstance
interface LegoPartInstance {
  // ... 其他属性
  animation?: AnimationState;
}
```

### 【前端】3. 历史栈与命令抽象
```typescript
interface ActionCommand {
  type: 'SNAP' | 'DETACH' | 'MOVE_TO_WORKBENCH' | 'RECYCLE';
  execute: () => void;
  undo: () => void;
  snapshot: any; // 保存动作发生前的必要快照（如 JointState 或局部连接图）
}

interface HistoryState {
  past: ActionCommand[];
  future: ActionCommand[];
  pushAction: (cmd: ActionCommand) => void;
  undo: () => void;
  redo: () => void;
}
```

### 【前端/后端】4. 拆解意图与闭环扫描
```typescript
// 前端：双击拆解意图参数
interface DetachIntent {
  edgeId: string;
  activePartId: string;       // 点谁谁走
  anchoredPartId: string;     // 保持不动
}
```

```python
# 后端 topology_manager.py
class TopologyManager:
    def scan_and_seal_loops(self, moved_part_ids: List[str], distance_threshold_m: float = 0.001) -> List[dict]:
        """
        在主连接完成后，扫描并闭合邻近的可用端口。
        返回新建立的闭环连接边列表。
        """
        pass
```
</architecture>

<negative_constraints>
- **严禁暴力位移**：在触发 `Snap` 或 `Detach` 后，不要直接将目标坐标赋给零件的 `position`，必须通过生成 `AnimationState` 过渡。
- **严禁状态丢失**：不可在实现 `undo/redo` 时采用暴力深拷贝整个场景图的方式，必须采用命令模式只保存局部变更的 Diff，以保证性能。
- **分离物理与视觉**：处于 `ANIMATING_SNAP` 阶段的零件不应参与物理引擎的碰撞检测，直到其 `onComplete` 回调正式将其写入连接图。
</negative_constraints>

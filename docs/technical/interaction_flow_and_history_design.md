# 交互流与操作历史设计文档：状态机、动画与命令模式

> **To Claude Code CLI:**
> Please read the following files into your context immediately:
> - `frontend/src/store.ts` (前端状态机与操作流核心)
> - `topology_manager.py` (后端多点闭环扫描逻辑扩展点)

<directory_structure>
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
├───topology_manager.py      # 待扩展：新增多点自动闭环扫描 (Auto-Snap Scanner)
└───frontend/src/
    └───store.ts             # 待扩展：新增 FSM, AnimationTrack, Undo/Redo
</directory_structure>

<current_pain_points>
1. **组装流状态含糊**：仅凭 `selectedPort` 无法严谨表达用户是处于“游场模式”还是“锁定源端口准备落位”的阶段。
2. **缺乏动画载体**：改变位置是瞬间完成的，没有抽象出 `AnimationState` 来支撑文档中要求的“滑入动画”和“物理退位动画”。
3. **拆解意图无法解析**：没有区分双击事件中射线击中的是哪一侧零件，会导致无法实现“点谁谁走”。
4. **无 Undo/Redo 栈**：销毁、暂存（Staging）、连接动作没有被封装为命令模式（Command），一旦误操作无法回退。
5. **多点盲区**：单次 Snap 结束后，系统不会自动扫描邻近 `<1mm` 的端口去形成闭环。
</current_pain_points>

<core_design_rules>
### 1. 交互状态机 (Interaction FSM)
前端必须引入显式的阶段枚举（`InteractionPhase`），严格控制鼠标点击事件在不同阶段下的响应逻辑。

### 2. 命令模式与历史栈 (Command Pattern & History)
所有改变场景状态的操作（Snap、抽取、移入暂存区 Staging Tray、颜色变更[待定]）必须封装为 `ActionCommand`。Store 维护 `past` 和 `future`。

### 3. 补间动画管理器 (Animation Track)
改变零件位姿不应直接暴力赋值，应通过 `AnimationState` 过渡。**滑动定深 (Slide along Axis)** 的交互过程本身就是一个受限的实时位姿变换轨道。

### 4. 拆解主动侧判定 (Active Side Detachment)
遵循“谁被点中谁移动”的原则。系统通过点击锚点确认移动重心。

### 5. 自动闭环扫描 (Auto-Snap Scanner)
在主 Snap 动作和“滑动步进”完成后触发。当两个不相关的端口间距小于 1mm 时，自动补全拓扑连接。
</core_design_rules>

<architecture>
## 数据结构与接口定义建议

### 【前端】1. 交互流状态机
```typescript
export enum InteractionPhase {
  IDLE = 'IDLE',                       // 空闲模式
  PREVIEWING = 'PREVIEWING',           // 正在预览零件
  SOURCE_LOCKED = 'SOURCE_LOCKED',     // 已锁定源端口，寻找目标
  AXIAL_SLIDING = 'AXIAL_SLIDING',     // 完成 Snap，正在鼠标拖动调节深度 (v1.2)
  ANIMATING_SNAP = 'ANIMATING_SNAP',   // 正在播放滑入动画
}
```

### 【前端】2. 历史栈与命令抽象
```typescript
interface ActionCommand {
  type: 'SNAP' | 'DETACH' | 'MOVE_TO_STAGING' | 'RECYCLE' | 'AXIAL_MOVE';
  execute: () => void;
  undo: () => void;
  snapshot: any; // 保存动作发生前的局部快照（零件位姿、连接图）
}
```

### 【前端/后端】3. 拆解意图与闭环扫描
```typescript
// 前端：双击拆解并移入 Staging Tray
interface DetachIntent {
  edgeId: string;
  activePartId: string;       // 点谁谁走
  anchoredPartId: string;     // 保持不动
}
```
</architecture>

<negative_constraints>
- **严禁暴力位移**：在触发 `Snap` 或 `Detach` 后，必须通过产生 `AnimationState` 过渡到最终位姿。
- **严禁状态丢失**：不可采用暴力深拷贝整个场景图的方式，必须采用命令模式只保存局部变更的 Diff。
- **术语规范**：禁止再使用任何包含 `Workbench` 字样的接口名或注释。
</negative_constraints>

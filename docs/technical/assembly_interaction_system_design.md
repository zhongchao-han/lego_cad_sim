# 技术设计文档：装配交互系统架构与接口定义

> **To Claude Code CLI:**
> Please read the following files immediately...
> - `frontend/src/store.ts` (For UI/Sim State Management)
> - `topology_manager.py` (For Gear Loop & Chain logic)

<system_integrity_definitions>
...

**深度稳定性补丁 (Deep Stability Patches)：**

1. **齿轮链相位一致性 (Gear Chain Consistency)**：
   - **逻辑**：自动咬合算法支持链式传递。若产生齿轮闭环，系统必须验证全环齿隙相位是否自洽。
   - **拦截**：若相位冲突（无法转动），即使中心距正确，也必须判定为 `BLOCKED`。

2. **干涉热图辅助 (Interference Highlighting)**：
   - **动作**：当你操作零件发生几何干涉（重叠部分）时，系统自动将被遮挡或冲突的 Mesh 以红色脉冲高亮显示。
   - **目的**：为用户提供明确的故障诊断信息。

3. **仿真模式隔离 (Simulation Cold-Isolation)**：
   - **规则**：`SIMULATION` 模式仅对主画布（连通图）生效。
   - **执行**：暂存区 (Staging Tray) 的所有零件块在模拟期间自动冻结，不参与动力学解算，确保仿真性能。

4. **历史快照补齐 (Undo/Redo)**：
   - 暂存区的“彻底销毁”动作、零件的“回收”动作、以及 Snap 后的“位移手动调节”完成动作必须全部进入 Undo 栈。
</system_integrity_definitions>

<core_design_rules>
1. **先选即动**：Source 移动到 Target。
2. **目标即锚点**：落位瞬间重置 ROOT。
3. **安全销毁**：暂存区清理需二次确认。
4. **智能咬合**：支持链式自动相位对齐。
5. **落位对齐：Z 轴反向对齐 (Point-to-Point Alignment)**：
   - **说明**：已废弃旧的 `stripAxis` 投影算法（因为它会导致特殊零件如 6558 的反转 Bug）。
   - **逻辑**：强制源端口 Z 轴与目标端口 Z 轴反向平行，中心点重合，实现 1:1 精准落位。
6. **全连接约束**：禁止生成任何孤立零件块。
</core_design_rules>

### 交互 1.2 规范 (Interaction v1.2 Spec) - 核心交互逻辑补全

为了增强机械组搭建的深度与精准度，系统遵循以下高阶交互逻辑：

#### A. 拓扑级选择：Site (物理场站) 与 Port (交互端口)
- 每个零件定义分为 **Site**（物理坐标位，如一个圆孔中心）和 **Interaction Ports**（该孔位的不同进入方向）。
- **交互方式**：通过点击 3D 空间中指向不同方向的 **Gizmo 箭头** 来进行精准的方向锁定。

#### B. 深度调节：Snap-then-Slide (手势滑动)
- **动作**：用户点击 Snap 对齐后，**不松开鼠标** 即可沿对齐轴线前后拖拽零件。
-   **步进**：逻辑步进 20 LDU (1 STUD)，支持磁力感吸附。
-   **物理限位**：最大/最小深度自动由零件碰撞边界和物理法兰（Flange）动态计算决定。

#### C. 姿态调节：UI 按钮步进旋转
- 选中已连接零件时，弹出上下文浮动工具条。
- 提供 **[+90/-90]**, **[+45/-45]**, **[+1/-1]** 旋转按钮。
- **自由度锁定 (DOF Sensing)**：如果零件是多点约束或交叉约束，系统自动隐藏旋转 UI 以防止非物理操作。

#### D. 子装配体抓取：锚点选择 (Anchor Mode)
- **逻辑**：点击零件默认选中其所属的 **整个物理连通体**（Connected Components）。
- **排除**：按住 `Ctrl` 点击可排除特定的零件进行独立移动或“抽取”。

<negative_constraints>
- **严禁支持柔性零件 (No Flexible Parts)**：本系统仅支持刚体物理。
- **严禁在仿真模式下操作暂存区**：暂存区在物理引擎运行时必须处于锁定状态。
</negative_constraints>

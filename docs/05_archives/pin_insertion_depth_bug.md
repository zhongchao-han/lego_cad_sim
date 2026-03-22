# Technical Spec: LEGO CAD 交互对齐与空间治理规范

> **To Claude Code CLI:**
> Please read the following files immediately into your context:
> - `frontend/src/store.ts` (Core State)
> - `port.py` (Normalization Logic)
> - `assembly.py` (Kinematics)

<current_pain_points>
- 插入深度偏置：缺失 `stripAxis` 投影对齐。
- 交互逻辑生硬：缺乏物理回馈与空间层级感。
- 拓扑管理混乱：多重连接与重连路径不清晰。
</current_pain_points>

<space_management_policy>
**三区逻辑定义 (The Three-Zone Policy)：**
1. **活跃主画布 (Active Arena)**：中心交互区，进行 `Snap` 与物理仿真。
2. **暂存工作台 (Workbench Zone)**：
   - 坐标：$X \in [0.15, 0.4]$ 侧边区域，预设 $N \times M$ 固定槽位。
   - 存入逻辑：双击拆解产生的子零件块 (|S| > 1) 自动滑入。
   - 状态：处于非活跃渲染态，不参与主运动学计算。
3. **物料盒 (Inventory Box)**：
   - UI 列表，存放单零件实例及其参数化模板。
   - 回收逻辑：双击拆解产生的单零件 (|S| = 1) 自动回收并销毁 3D 实例。
</space_management_policy>

<assembly_workflow_detail>
**焦点预览装配流 (Focused-Preview Assembly)：**
1. **焦点翻转 (Inspect)**：点击物料进入预览层，支持 360° 自由 Orbit 观察端口。
2. **源端口锁定 (Source Lock)**：在预览层点击 $P_{src}$。
3. **落位动画 (Animation)**：点击主画布目标，物件从预览层平滑滑入主画布，通过 `stripAxis` 进行 100% 精准对齐。
4. **地基初始化 (Grounding)**：空画布第一个落位零件标记为 `ROOT`（地基），锁定 6-DOF。
</assembly_workflow_detail>

<interaction_refinement>
**“点谁谁走”之轴向步进拆解 (Physical Step-wise Detachment)：**
1. **双击端口原则**：双击侧所属零件定义为“主动侧”，对向侧定义为“锚定侧”。
2. **多重连接处理**：若双击断开后仍有其他约束（如双销连接、闭环），零件原地不动，仅该端口状态置为“断开”。
3. **物理退位动画**：若仅存最后一个约束，点击侧零件沿插入轴反向滑行 20 LDU（弹出），产生物理隔离感。
</interaction_refinement>

<system_integrity_definitions>
**刚体几何约束 (Rigid Body Constraints)：**
1. **多点自动吸附**：主连接完成后，系统自动扫描 1mm 内对齐的未连端口，自动闭合并升级连接类型。
2. **合法性校验**：二次连接前，必须验证 $Distance(SourcePorts) = Distance(TargetPorts)$，若距离不匹配，执行“碰撞回退”并提示非法。
3. **容量检测**：单个孔位支持多重插入，前提是插入深度的累加和不超过孔深。
</system_integrity_definitions>

<core_design_rules>
- **废弃“物件跟随鼠标”**：改为预览到画布的动画轨迹。
- **废弃“质量判断主体”**：改为严格的“双击侧为主动侧”。
- **强制轴心对齐**：所有 `Snap` 路径必须调用 `stripAxis`。
</core_design_rules>

<negative_constraints>
- **严禁强制对齐非法孔距**。
- **不要在拆解多重约束时误删零件**：需遵循逐层剥离逻辑。
</negative_constraints>

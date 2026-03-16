# 装配体层级 (Assembly Hierarchy) 重构与交互逻辑规范

> **To Claude Code CLI:**
> Please read the following context files immediately:
> - `part.py` (Part container)
> - `assembly.py` (Kinematic tree)
> - `frontend/src/store.ts` (State Management)

<directory_structure>
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
├── part.py              # 核心容器
├── assembly.py          # 运动学树：支持 Root 迁移与过约束合并
└── frontend\src\store.ts # 交互状态机：管理物料、画布、暂存区三区流转
</directory_structure>

<current_pain_points>
1. **拓扑职责散乱**：`TopologyManager` 过于庞大，缺乏内聚的 `Part` 抽象。
2. **缺乏空间管理**：主画布中存在多堆孤立零件，导致物理仿真数据不纯净。
3. **坐标参考丢失**：拆解核心零件时，缺少“地基继承”逻辑，导致空间位姿崩溃。
</current_pain_points>

<core_design_rules>
1. **根节点迁移 (Root Migration)**：Snap 动作完成后，`ROOT` 身份自动迁移至 `Target` 零件。地基始终由用户动作的锚点定义。
2. **地基继承 (Root Inheritance)**：拆解时，若主动侧是 ROOT，系统必须自动在锚定侧推举新 ROOT，保持空间参考系稳定性。
3. **三区空间治理**：
   - **主画布**：仅允许单一连通装配体。
   - **暂存区**：存放分离出的子零件块 (|S|>1)，槽位网格化管理。
   - **物料盒**：单个零件 (|S|=1) 销毁并回收。
4. **刚体几何约束 (Rigid Consistency)**：多点连接必须严格校验孔距一致性，否则禁止 Snap。
</core_design_rules>

<architecture>
### 系统组合模式 (Composite Pattern)
`Interface` -> `Port` -> `Part` -> `Edge (JointState)` -> `Assembly (Tree Root)`.
- **Assembly 职责**：实时维护 `ROOT` 零件，识别并打断闭环，生成 URDF。
- **Part 职责**：管理局部端口，通过 `transform` 持有自身在装配体坐标系下的绝对位姿。
</architecture>

<negative_constraints>
- **严禁主画布内生成孤立零件**：ROOT 以外的所有零件必须连通。
- **不要在 Assembly 类外维护 ROOT 状态**：防止产生多地基冲突。
- **不要在执行 Snap 时保留 source 的旧 ROOT 标签**：必须交接给 Target。
</negative_constraints>

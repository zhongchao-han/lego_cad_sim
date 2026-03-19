# 装配体层级设计文档 v2 — 全类图、交互规范与测试覆盖矩阵

> **To Claude Code CLI:**
> Please read the following context files immediately:
> - `port_semantics.py` (Interfaces & fit logic)
> - `port.py` (Port normalization & geometry)
> - `connection_edge.py` (Edge & JointState)
> - `topology_manager.py` (TopologyManager & PartNode)
> - `port_library.py` (Semantic Library)
> - `frontend/src/store.ts` (Frontend state machine)

---

## 1. 当前方案问题分析

在对代码与文档进行核对后，发现以下实现与设计规则的偏差：

### 1.1 `store.ts` — `moveTargetToSource` 违反"先选即动"原则

**文件**：`frontend/src/store.ts` 第 249 行
```ts
const moveTargetToSource = srcConnected && isPegIntoHole;
```
**问题**：这是一个隐式启发式判断——当插销已有连接时自动改变"谁动"，与设计规则"第一个点击的端口所属零件（Source）永远移动"直接矛盾。`pin_clipping_issue.md` 明确标注"不要保留任何 moveTargetToSource 的启发式判断"，但此逻辑至今保留。

### 1.2 `store.ts` — `stripAxis` 应用不一致

**文件**：`frontend/src/store.ts` 第 311–313 行
```ts
const targetAlignLocal = target.portType === 'peg'
  ? target.position          // ← stripAxis 被跳过！
  : stripAxis(target.position, tgtAxisLocal);
```
**问题**：当 target 端口类型为 `peg` 时跳过 `stripAxis`，违反"所有 Snap 路径必须调用 stripAxis"规则，导致插销作为目标时产生深度偏置。

### 1.3 `TopologyManager` 类职责增强 (原 `Assembly` 类)

**文件**：`topology_manager.py`
**当前状态**：
- 已统一使用 `TopologyManager` 管理运动学树。
- 移除了冗余的 `assembly.py` 和 `part.py`。
- `PartNode` 承载了原 `Part` 的所有核心属性（ID, Name, Ports）。

### 1.4 缺少刚体孔距一致性校验

`assembly_interaction_system_design.md` 要求多点连接时强制验证 `Distance(SourcePorts) == Distance(TargetPorts)`，但 `Assembly.connect_ports()` 及 `ConnectionEdge.is_physically_compatible()` 均未实现此校验。

### 1.5 测试覆盖空白

| 模块 | 现有测试文件 | 缺失场景 |
|------|------------|---------|
| `ConnectionEdge` | 嵌入 `test_insertion.py` | 独立单元测试文件缺失 |
| `Assembly` ROOT 迁移 | 无 | 整个 ROOT 逻辑无测试 |
| `store.ts` stripAxis 一致性 | `snapMath.test.ts` 仅测轴向提取 | 未覆盖 peg-as-target 场景 |
| 刚体孔距校验 | 无 | 逻辑本身尚未实现 |

---

## 2. 系统类层级与职责边界

```
ConnectionInterface          — 物理接口描述符（不可变值对象）
    └── get_interface()      — 注册表查表工厂
    └── check_fit()          — O(1) 参数化配合检测
    └── derive_joint_params()— 关节类型推导

Port                         — 带物理语义的空间端口（Z轴=插入方向）
    ├── from_raw()           — 主工厂（从LDraw原始矩阵加载，含归一化）
    ├── from_config()        — 精准工厂（从 verified JSON 数据库直接加载）
    ├── insertion_axis       — 插入方向（rotation[:,2]）
    ├── test_fit_with()      — 配合检测（委托 check_fit）
    ├── derive_joint()       — 关节推导（委托 derive_joint_params）
    └── calculate_relative_transform() — 对扣变换矩阵

JointState                   — 连接边运行时动态状态（可序列化）
    ├── insertion_depth      — 插入深度 (m)
    └── rotation_angle       — 绕 Z 轴旋转 (rad)

ConnectionEdge               — 两零件端口间的物理连接
    ├── port_parent          — 父端口 (Port)
    ├── port_child           — 子端口 (Port)
    ├── state                — JointState
    ├── is_merged            — 过约束合并标记
    ├── is_physically_compatible() — 物理校验
    └── get_relative_transform()   — 委托 port_parent

PartNode                     — 乐高零件实体节点（原 Part 类）
    ├── part_id              — 原始 ID (6558.dat)
    ├── name                 — 实例 ID (p_6558_0)
    ├── ports                — Dict[str, Port]
    └── [已聚合] transform / global pos 逻辑

TopologyManager              — 拓扑管理器（原 Assembly 类）
    ├── graph                — nx.MultiDiGraph (存储全量拓扑)
    ├── closed_loops         — 被打断的闭合回路边
    ├── add_part()           — 注入零件节点
    ├── connect_ports()      — 建立物理连接（含 Fit 校验）
    ├── build_spanning_tree()— BFS 解算运动学生成树
    └── export_urdf()        — 委托 URDFExporter 输出物理描述文件
```

---

## 3. 类交互序列

### 3.1 Snap 完整流程（Python 后端）

```
用户点击两端口
    │
    ▼
Assembly.connect_ports(ConnectionEdge)
    ├── 校验：parent_id / child_id 在 parts 中
    ├── ConnectionEdge.is_physically_compatible()
    │       └── Port.test_fit_with(other)
    │               └── check_fit(plug, socket)
    │                       └── FitType
    ├── 追加到 self.connections
    └── 更新 _kinematic_graph

    [Snap 完成后]
Assembly.migrate_root(target_id)   [待实现]
    └── self.root_part_id = target_id
```

### 3.2 前端 snapParts 流程（store.ts）

```
snapParts(source, target)
    │
    ├─ 1. 提取插入轴（Z轴约定）
    │     srcAxisLocal = mat3MulVec3(source.rotation, [0,0,1])
    │     tgtAxisLocal = mat3MulVec3(target.rotation, [0,0,1])
    │     *在世界空间 quatApplyToVec3(quaternion, axisLocal)
    │
    ├─ 2. 旋转 Source 组（绕 pivot）对齐轴向
    │     qDelta = quatFromUnitVectors(srcAxis, tgtAxis)
    │     *所有 srcGroup 零件绕 sourcePart.position 旋转
    │
    ├─ 3. 平移（stripAxis 投影）
    │     srcAlignWorld = position + R(stripAxis(portPos, axisLocal))
    │     tgtAlignWorld = position + R(stripAxis(portPos, axisLocal))  ← 必须也对 peg 应用
    │     delta = tgtAlignWorld - srcAlignWorld
    │
    ├─ 4. [可选] POST /api/insertion_check 物理验证
    │
    └─ 5. 更新 connections 图 & POST /api/snap_parts 同步后端
```

### 3.3 URDF 导出流程

```
Assembly.resolve_kinematics()
    ├─ 步骤1：_kinematic_graph 多重边 → 简单图（过约束边 is_merged=True）
    │         is_merged=True → derive_joint_params(is_overconstrained=True) → "fixed"
    └─ 步骤2：BFS 生成树（从 root_part_id 或 in-degree=0 节点出发）
              └─ 跳过已访问节点的边 → closed_loops

URDFExporter.export(tree, closed_loops, output_path)
    ├─ 每个节点 → <link>
    └─ 每条边 → ConnectionEdge.port_parent.derive_joint() → <joint>
```

---

## 4. 接口约定

### 4.1 Z 轴插入方向约定（核心不变量）

所有经 `Port.create_from_ldraw()` 创建的端口保证：
- `rotation[:, 2]` = 插入方向单位向量
- FEMALE (孔)：Z 轴指向孔开口方向（接受插入的方向）
- MALE (销)：Z 轴指向销突出方向
- 连接条件：`Z_plug ≈ -Z_socket`（反向对扣）

前端等效：
- `mat3MulVec3(port.rotation, [0, 0, 1])` = 插入轴（**必须使用 Z 轴，禁止使用 Y 轴**）

### 4.2 stripAxis 投影约定

```python
# 端口在零件几何中心轴上的投影位置 = 端口位置 - 沿插入轴的分量
center = portPos - dot(portPos, insertionAxis) * insertionAxis
```

TypeScript 等效（store.ts `stripAxis`）：
```ts
const stripAxis = (pos: Vec3, axis: Vec3): Vec3 => {
  const d = vecDot(pos, axis);
  return vecSub(pos, vecScale(axis, d));
};
```

**规则**：无论 source 还是 target，无论 peg 还是hole，`stripAxis` 必须在 Snap 位移计算前被调用。

### 4.3 ROOT 迁移约定（待实现）

| 动作 | ROOT 行为 |
|------|----------|
| 空画布落下第一个零件 | 该零件设为 ROOT，锁定 6-DOF |
| Snap(source → target) | ROOT 迁移至 target 零件 |
| 拆解时 ROOT 是主动侧 | 系统在锚定侧推举新 ROOT |
| ROOT 始终唯一 | Assembly 在类外禁止维护 ROOT 状态 |

---

## 5. 单元测试覆盖矩阵

### 5.1 Python 测试文件

| 测试文件 | 被测类/函数 | 关键测试场景 |
|---------|-----------|------------|
| `tests/test_port_connections.py` | `Port`, `ConnectionInterface` | 配合类型、关节推导、Z轴归一化、工厂方法、to_dict |
| `tests/test_insertion.py` | `Part`, `ConnectionEdge`, `Assembly`, `URDFExporter` | 完整插入生命周期、物理校验、过约束、闭环 |
| `tests/test_port_projection.py` | `server.py` 投影函数 | Z轴正确/Y轴bug、插销/孔端口投影 |
| `tests/test_connection_edge.py` ⬅ **新增** | `ConnectionEdge`, `JointState` | 独立边逻辑、状态变更、repr |

### 5.2 TypeScript 测试文件

| 测试文件 | 被测函数 | 关键测试场景 |
|---------|---------|------------|
| `frontend/src/snapMath.test.ts` | `mat3MulVec3`, baseAxis | Z轴提取正确、Y轴bug演示 |
| `frontend/src/snapParts.test.ts` ⬅ **待补充** | `snapParts`, `stripAxis` | peg作为target时stripAxis必须被调用 |

### 5.3 缺失测试场景（优先级排序）

**P0 — 阻断性缺陷**
- [ ] `store.ts` peg-as-target 时 `stripAxis` 未应用 → 产生深度偏置
- [ ] `store.ts` `moveTargetToSource` 启发式与"先选即动"冲突

**P1 — 架构完整性**
- [ ] `Assembly.set_root()` / `migrate_root()` 方法（类尚未实现）
- [ ] `Assembly.resolve_kinematics()` 使用 `root_part_id` 而非入度推断

**P2 — 功能覆盖**
- [ ] 刚体孔距一致性校验（`Distance(SourcePorts) == Distance(TargetPorts)`）
- [ ] `disconnect_parts()` 后 ROOT 自动迁移
- [ ] `JointState` Undo/Redo 快照（仅序列化状态，不重建拓扑）

---

## 6. 设计规则（Design Rules）

1. **先选即动 (Source-to-Target)**：Source 零件永远移动，Target 永远是锚点。禁止任何基于连接状态/质量的"谁动"启发式判断。
2. **强制轴心投影 (stripAxis)**：所有 Snap 位移必须调用 `stripAxis` 消除轴向分量后再计算目标位置，无一例外。
3. **动态 Z 轴提取**：插入轴 = `rotation[:, 2]`。前端 = `mat3MulVec3(rot, [0,0,1])`。禁止硬编码 Y 轴。
4. **ROOT 动态迁移**：Snap 完成后 ROOT 自动转移至 Target 零件，保证地基始终由用户最后的落点定义。
5. **Assembly 是 ROOT 的唯一守护者**：禁止在 Assembly 类外维护 root_part_id。
6. **过约束合并**：同一对零件间多条连接边自动降级为 Fixed Joint（is_merged=True）。
7. **闭环打断**：BFS 生成树跳过产生环路的边，记入 closed_loops 供 URDF Gazebo 约束标签使用。

---

## 7. 禁忌约束（Negative Constraints）

- **严禁** 使用表面端口原始坐标对齐（必须先 `stripAxis` 投影到几何中心轴）
- **严禁** 在 Snap 代码中保留 `moveTargetToSource` 类型的启发式判断
- **严禁** 在 Assembly 类外维护 ROOT 状态（防止多地基冲突）
- **严禁** 执行 Snap 后保留 source 的旧 ROOT 标签
- **严禁** 在主画布内生成孤立零件块（ROOT 以外所有零件必须连通）
- **严禁** 强制对齐非法孔距（孔距不匹配时必须执行碰撞回退并提示）
- **严禁** 硬编码 Y 轴为插入轴（必须动态提取旋转矩阵 Z 列）

---

## 附录：目录结构与类所在文件

```
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
├── backend/                 # 后端核心逻辑
│   ├── server.py            # FastAPI 端点
│   ├── port_library.py      # 语义库加载器
│   ├── port_semantics.py    # 物理接口配合语义
│   ├── port.py              # Port 实体
│   ├── topology_manager.py  # 拓扑逻辑
│   ├── urdf_exporter.py     # URDF 导出
│   ├── ...                  # 其他 .py 模块
│   └── tests/               # 后端测试
├── data/                    # 动态数据
│   └── ldraw_port_configs.json # 零件端口真理数据库
├── docs/                    # 文档系统
├── ldraw_lib/               # 静态资源库
├── ldraw_meshes/            # 缓存网格
└── core_constants.py        # [已移入 backend/]
```

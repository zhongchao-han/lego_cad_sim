# LEGO CAD 仿真：装配对齐逻辑与算法规范 (v3.1 Site-Based)

## 0. 设计目标 (Design Goal)
确保零件在 3D 空间内的 **“绝对精准落位”**。取消一切基于坐标投影或文件名猜测的模糊逻辑，转向纯粹的 **“锚点驱动 (Anchor-Driven)”** 架构。

---

## 1. 核心算法：Point-to-Point (P2P) 对齐

### **1.1 算法定义**
当源场站 (Source Site) 对齐到目标场站 (Target Site) 时，系统在底层寻找最匹配的语义端口（Port）并执行以下几何约束：
- **轴向对冲 (Anti-Parallel)**: `Z_source = -Z_target` (强制 Z 轴反向平行)。
- **中心重合 (Coincident)**: `Position_source = Position_target` (中心点欧几里得距离为 0)。
- **单一自由度初始化**: 对齐后的位姿作为 **Base Pose**，仅保留沿 Z 轴的一维平移自由度。

### **1.2 为什么交互发生在 Site 层面？**
- **歧义消解**: 许多零件（如十字孔+圆孔的组合）在物理空间同中心。Site 作为空间分组，在交互时提供单一的点击靶点，并在底层自动匹配最合适的 Port (如 Axle 找 AxleHole)。
- **允许后续滑动 (Axial Sliding)**: 具有严密的数学运动轴心。

---

## 2. 交互操作序列 (Interaction Sequence)

```mermaid
sequenceDiagram
    participant User as 用户
    participant UI as 预览窗口/视口
    participant Store as 前端及拓扑管理器 (FSM / Topology)
    participant Engine as 后端物理引擎

    %% Phase 1: 预防与意图锁定
    Note over Store: Phase: IDLE
    User->>UI: Viewport 悬停目标
    UI->>Store: PREVIEWING (意图过滤/渲染 Gizmo)
    User->>UI: 点击源位点 (Source Site)
    UI->>Store: SOURCE_LOCKED (锁定位点属性)

    %% Phase 2: 目标锁定与计算请求
    User->>Store: 点击目标位点 (Target Site)
    Note over Store: Phase: ANIMATING_SNAP (屏蔽输入)
    Store->>Engine: 请求 Site P2P 对齐矩阵 (snap_parts)

    %% Phase 3: 后端拓扑闭合并下发
    Engine-->>Engine: Backend Auto-Latching (扫描相交 Site)
    Engine->>Store: 返回 4x4 变换结果 <br/> & 拓扑连接集 (connections)

    %% Phase 4: 渲染动画与拓扑更新
    Store->>Store: TopologyManager 注册新连接 (持久化)
    Store->>User: 播放平滑滑入动画 (自动视口过渡)

    %% Phase 5: 微调验证与提交
    Note over Store: Phase: AXIAL_SLIDING
    User->>Store: 沿 Z 轴鼠标拖拽
    Store->>Engine: checkMotion(delta) 判断干涉
    Engine->>Store: 返回阻力/碰撞预判
    Store->>User: 渲染定深动画并应用位移

    %% 闭环
    Store->>Store: 提交深度 (Commit)
    Note over Store: Phase: IDLE (重置态)
```

---

## 3. 业务规则 (Business Rules)

1.  **P2P 强制执行**: 禁止使用轴向投影。所有 Snap 动作落位点偏移必须小于 `1e-6`。
2.  **深度滑动 (Sliding Rule)**: 落位后产生的一维位移存入 `ConnectionEdge.depthOffset` 字段，不改变零件局部模型，只改变拓扑相对偏移。
3.  **自由度自感应 (DOF Sensing)**:
    - 依据 Site 的截面形状 (Circle/Cross) 自动产生物理 Joint。
    - 当出现多根轴平行连接时，系统自动锁定绕轴旋转自由度。
4.  **视口自动对齐 (Auto-Frame)**: 每一个 Snap 动作完成后，相机焦点自动向目标 Site 平滑过渡，消除微观交互时的虚晃。

---

## 4. 几何端口语义与拓扑生成规则 (Port Topology Rules)

为保证 P2P 的准确切面贴合与带凸缘（Flange）零件的防穿模交互，底层几何解析器 (`GeometryProcessor`) 对 LDraw 原件的提取执行以下**绝对空间对齐与分裂规范**：

1. **贯通孔双面分裂 (Through-hole Split)**:
   对于 `beamhole`, `connhole`, `crosshole` 等定义为 `1 Lego Unit (20 LDU)` 标准厚度的离散通孔，**不得提取原点作为单一端口**。系统必须在孔的正反两侧切面（距中心偏置 `±10 LDU`）强制产生两个法向严格相反、位置对称的“表面端口”。这样做的目的是提供真实的物理切面阻隔点，使 UI 射线能捕捉前后插入意图。
2. **单侧盲孔锚定 (Blind-hole Surface Anchoring)**:
   对于 `peghole` 等底部不连通的单端盲孔，直接在模型定义的接触面原点提取单一向外法向的端口，**严禁双向分裂**以防在实体内部生成无法拾取的幽灵连接腔。
3. **连续多位点组件空间偏置补偿 (Continuous Array Centering)**:
   对于长轴 (`axle.dat`)、深孔管 (`axlehol8.dat`) 等长度大于一步进单位的连续延伸组件，禁止简单从边缘累加步长。必须以结构的全局几何域中心归一化（如 `local_y = 0.5`），再配合居中对称分布等式 `(k - N/2 + 0.5) * 20 LDU`，以抵消端部非标准倒角误差。从而保证阵列提取的端口在绝对空间完美座落于每个标准单元格的“功能中心”。

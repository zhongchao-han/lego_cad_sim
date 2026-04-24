# LEGO Technic CAD & Physics Simulation

本项目是一个专注于 LEGO Technic（乐高机械组）构件的、由拓扑约束驱动的交互式 CAD 与物理仿真软件系统。
传统 CAD（如 LeoCAD）大多依赖绝对空间坐标系，而本系统独家实现了**基于语义连接节点（Smart Snapping）的拓扑建图方式**。这允许组件进行自动物理贴合，并可打散图网络导出用于 ROS 等机器人平台的通用语言。

项目具备两大生命周期环境：
1. **组装模式 (Assembly / Kinematic Mode):** 于零重力（漂浮）状态下进行无物理引擎干预的建模搭建。
2. **仿真模式 (Simulation / Dynamic Mode):** 一键热切换，系统将其转换为具备连续碰撞防穿模（CCD）、离合阻尼（Clutch Power）以及带有真实惯性张量的 PyBullet 并行世界，在 60Hz 推流下验证您的物理架构和齿轮/连杆运动学死环。

---

## 🏗️ 核心架构与技术栈

整个软件分为包含五个阶段的纵深耦合系统：

### 1. 物理几何提纯后端 | `ldraw_parser.py`
 - **模块:** `trimesh`, `numpy`
 - **职责:** 载入 `.dat` 原始模型数据。自动将古老的乐高 LDU（1 LDU = 0.4mm）缩放映射至 SI（千克/米）。对复杂外形实时测算其实际 ABS 质量估计、重力质心点位 (CoM)、极其重要的三维惯性张量 (Inertia Tensor) 乃至外调 V-HACD 处理拆解物理刚体凸包碰撞壳。

### 2. 图论与 URDF 翻译引擎 | `topology_manager.py`
 - **模块:** `networkx`, `scipy.spatial.transform`
 - **职责:** 将每一次乐高上的 “扣合” 作为一个 `ConnectionEdge` 添加进 多重有向图(MultiDiGraph) 中。利用此网络：
   - 支持**多组件森林结构 (Topological Forests)**，允许工作台上存在无数个互不相连、独立运算的 Group (连通分量)，实现真正的自下而上并行装配。
   - 侦测零件面面的多节点联结，进行 **Over-Constraint 降维合金融断**（防止物理引擎张力撕裂爆炸）。
   - 广度优先探索(BFS)切断图环，生成严苛符合**树形（Tree）语意的 URDF 配置文件结构**。并将截断的死环保存作为事后补偿约束下挂。
   - `scipy` 三维姿态库推演零件间的相对 `Origin(XYZ) - RPY` （空间方位与变换矩阵）。

### 3. 微秒物理核 | `physics_engine.py`
 - **模块:** `pybullet`
 - **职责:** 挂载解出的 URDF，打通闭合回路补偿(`createConstraint`)。全局设定针对连续转动的摩擦阻滞离合等级(`friction pin`与轴区别对待)。注入 1毫米半径内的扫掠球 **CCD 防止快速形变引起的高速穿孔溃散（Tunneling Effect）**。

### 4. 数据泵与状态机网关 | `server.py`
 - **模块:** `fastapi`, `uvicorn`, `pydantic`
 - **职责:** 全权负责与 Web 前端进行的双打请求通信体系（JSON REST Api）。包含接受鼠标发力的外部载力点端口挂载、拓扑联结事件等。此外独立开设基于 `WebSocket` 的全息通道用于高帧频广播 240Hz/4 次平滑之后的 60fps Pybullet 绝对位姿。

### 5. Web前端装配仪 | `frontend/` (Vite)
 - **模块:** `React`, `Three.js`, `Zustand`, `@react-three/fiber`, `TailwindCSS`
 - **职责:** `Camera Anchor Lock`（智能锁定：点选构件孔洞后，相机立刻锁定轨道并完美在原点盘旋审视接缝细节）。`Smart Snapping GUI` 提供射击式吸附，不再忍受三维深空拼接错位的痛苦。彻底废绝前端 IK，完全照单收受后场推流 `position/quaternion`！

---

## 🚀 部署与使用指南

本项目分为前端和后端，为了顺畅运行它们，请开启两个不同的终端环境并分别运行启动指令：

### 启动后端 (Python 3.10+)

1. 推荐您建立并激活一个虚拟环境（或者全局运行）。由于底层使用高度科学类库，请执行核心类推库挂载：
```bash
# 位于 lego_cad_sim/ 根目录
pip install fastapi uvicorn pydantic pybullet networkx trimesh scipy numpy
```

2. 开启并暴露 8000 Web 端口启动实时运算伺服程序：
```bash
python -m backend.server
# 或者使用重启脚本：python scripts/restart_server.py
# 启动就绪后可供 React 获取引擎流。
```

### 启动前端控制台 (Node.js 18+)

1. 切入装配前端的目录，使用内置包管理器组装依赖：
```bash
cd frontend
npm install
```

2. 起步 Vite 开发伺服中心，启动游览器开始设计及组装仿真：
```bash
npm run dev
# 默认映射将于 http://localhost:5173 被开启运行。
```

---

## 🛠️ 正在计划中的特性

- [ ] 基于 URDF 加载原生 LDraw `.ldr` 配套 `.obj` 的材质呈现渲染体系。
- [ ] 针对履带/齿轮齿比的特异化 Joint 修改。
- [ ] UI端接入完整的 "零件库（Part Library）"面板。

*Developed and architected as highly decoupled sub-systems to ease testing, verification, and expansion handling specific nuances of mechanical constraints inherent with LEGO products!*

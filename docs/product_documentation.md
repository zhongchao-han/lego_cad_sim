# LEGO CAD Simulation System - 产品文档

## 1. 项目概览
本系统是一个高度模块化的乐高 CAD 仿真系统，旨在通过强类型的物理接口定义和高效的图论算法，实现从零件组装到物理引擎仿真的无缝对接。系统核心采用 Python 编写后端逻辑，React + Three.js 构建前端交互界面。

## 2. 核心架构设计

### 2.1 树状组合模式 (Composite Pattern)
系统从传统的平铺式图论结构重构为现代 CAD 标准的树状层级：
`ConnectionInterface` -> `Port` -> `Part` -> `ConnectionEdge (JointState)` -> `Assembly`。

### 2.2 核心实体定义
- **Part (零件)**: 独立的几何实体，管理自身的端口（Port）和位姿。
- **Port (端口)**: 零件上的连接点，包含物理接口语义和空间位姿，Z 轴始终指向插入方向。
- **ConnectionInterface (接口)**: 定义连接的物理属性（极性、形状、半径、深度），支持查表法匹配。
- **ConnectionEdge (连接边)**: 描述两个端口间的连接关系，并持有动态状态（JointState）。
- **Assembly (装配体)**: 管理零件集和连接边，负责提取无环运动学树。

## 3. 关键特性

### 3.1 强类型接口配合 (Plug-Socket System)
- **极性校验**: 必须是 MALE + FEMALE 才能连接。
- **形状匹配**: 仅同种截面形状（如 CYLINDER 或 CROSS）可互连。
- **查表法 (Parametric Fit)**: 通过预设的公差表判断间隙配合、摩擦配合或几何干涉，替代高开销的网格碰撞计算。

### 3.2 自动运动学推导
- **过约束处理**: 当两个零件间存在多处连接时，自动降级为固定关节（Fixed Joint）。
- **BFS 拓扑解环**: 自动识别并打断闭环，生成 URDF 专用的生成树。
- **闭环记录**: 闭环信息作为 Gazebo 物理约束导出，确保仿真的物理准确性。

### 3.3 URDF 导出
- 支持将装配体导出为标准 URDF 格式，包含质量、惯性、关节类型和物理阻尼参数，可直接用于 ROS 或 PyBullet 环境。

## 4. 模块职责划分
- `topology_manager.py`: 拓扑结构与 URDF 生成。
- `ldraw_parser.py`: LDraw 零件库解析与端口提取。
- `physics_engine.py`: 底层物理引擎集成。
- `server.py`: 提供前后端数据接口。
- `frontend/`: 基于 React 和 React-Three-Fiber 的可视化建模环境。

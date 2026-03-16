# LEGO CAD Simulation System - 测试文档

## 1. 测试目标
验证系统在不同层级的逻辑正确性、鲁棒性和前后端交互的稳定性，确保符合产品文档中所述的核心功能。

## 2. 单元测试 (Unit Testing)

### 2.1 端口与接口层 (Port & Interface)
- **Case 1: 极性匹配验证**
  - 测试：MALE + FEMALE (SUCCESS), MALE + MALE (FAIL), FEMALE + FEMALE (FAIL)。
- **Case 2: 形状兼容性**
  - 测试：CYLINDER + CYLINDER (SUCCESS), CYLINDER + CROSS (FAIL)。
- **Case 3: 配合公差判断**
  - 测试：销半径小于孔 (CLEARANCE), 销半径略大于孔 (FRICTION), 销半径远大于孔 (BLOCKED)。
- **Case 4: 轴归一化**
  - 验证工厂方法是否正确将不同 LDraw 原件的轴方向统一映射为 Z 轴。

### 2.2 零件层 (Part)
- **Case 1: 端口注册与查询**
  - 确保 Part 正确管理自身的 Port 列表。
- **Case 2: 全局几何计算**
  - 验证当 Part 发生位姿变换时，Port 的全局位置和轴向随之正确更新。

## 3. 集成与系统级测试 (Integration Testing)

### 3.1 装配体生命周期 (Assembly Lifecycle)
- **Case 1: 零件注册**
  - 确保 Assembly 能正确持有并索引多个 Part。
- **Case 2: 动态状态 JointState**
  - 修改插入深度 `insertion_depth`，验证相对变换矩阵的平移分量正确变化。
- **Case 3: 过约束自动降级**
  - 建立两个零件间的双销连接，验证生成的关节类型是否自动变为 `fixed`。
- **Case 4: 闭环检测与打断**
  - 构建 A-B-C-A 环状结构，验证 `resolve_kinematics` 是否生成了正确的无环树，并记录了闭环边。

### 3.2 导出校验 (Exporter)
- **Case 1: URDF XML 完整性**
  - 验证生成的 URDF 文件是否包含合法的 `robot`, `link`, `joint` 标签。
  - 验证物理阻尼（Damping）和摩擦系数在摩擦配合场景下的正确导出。

## 4. 浏览器前端测试 (Browser Testing)

### 4.1 UI 交互验证
- **Case 1: 场景加载**
  - 确认 Vite 预览环境正常启动，且页面能渲染 Three.js Canvas。
- **Case 2: 零件库选择**
  - 确认前端能正确发起 API 请求获取零件列表，并正确在面板中显示。
- **Case 3: 连接配合反馈**
  - 模拟用户连接操作，检查前端是否正确显示配合类型（间隙/摩擦/干涉）的可视化提示。

### 4.2 API 路由测试
- 验证 `/api/insertion_check` 是否正确返回符合新版接口标准的数据字典。

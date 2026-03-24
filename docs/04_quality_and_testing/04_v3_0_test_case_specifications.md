# LEGO CAD 仿真系统：全链路质量验证协议 (Test Case Specifications v3.0)

## 0. 质量公约 (Quality Covenant)
本协议规定了系统在 v3.0 归一化架构下必须通过的测试项。任何涉及物理坐标、网格导出及拓扑连接的修改，必须通过以下所有自动化与人工测试逻辑。

---

## 1. 离线资产管线验证 (Unit Tests: Asset Pipeline & Normalization)

### **Test 1.1: 坐标系归一化准度 (Rx180 & SI Scaling)**
- **输入**: LDraw 原始坐标点 `P_ldu = [20, 24, 0]` (20LDU, 24LDU, 0LDU)。
- **核心逻辑**: 调用 `CoordinateTransformer.normalize_pos(P_ldu)`。
- **预期输出**: `P_si = [0.008, -0.0096, 0]` (米制，Y-Up)。
- **断言 (Assertions)**: 
    - `abs(P_si.y - (-0.0096)) < 1e-7` (验证 Y 轴翻转与缩放)。

### **Test 1.2: 矩阵提纯与正交化 (Matrix Purification)**
- **输入**: 一个带有微小剪切形变或非标准缩放的 3x3 LDraw 旋转矩阵。
- **核心逻辑**: 调用 `purify_rotation_matrix()`。
- **预期输出**: 一个标准的、行列式为 1 的正交矩阵。
- **断言**: `is_orthogonal(result_matrix) == True`。

### **Test 1.3: 步长采样完整性 (Pitch-based Sampling)**
- **测试模型**: `32316.dat` (3L 梁) 或 `6558.dat` (3L 带摩擦销)。
- **预期输出**: 
    - 端口计数恰好为 3。
    - 端口间距精准等于 **0.008m** (20 LDU)。
- **断言**: `len(ports) == 3`, `dist(p0, p1) == 0.008`。

---

## 2. 空间对齐一致性验证 (Integration Tests: Spatial Sync)

### **Test 2.1: 模型与坐标系同步位姿 (GLB-JSON Sync)**
- **动作**: 针对任意零件生成 GLB 和 JSON。
- **验证点**: 
    - 提取 GLB 网格中的某个特征顶点（如零件最顶端的顶点坐标）。
    - 比对 JSON 中对应端口的 Y 坐标。
- **预期结果**: 二者必须在同一个 Y-Up 坐标系下对齐。
- **目的**: 彻底杜绝“模型是正的，点在模型外”或“模型是反的”这类方向性 Bug。

### **Test 2.2: 重建幂等性 (Idempotency)**
- **动作**: 对同一个零件连续执行两次 `--force` 重新生成。
- **预期结果**: 第二次生成的 `port_configs.json` 内容与第一次完全一致，无任何浮点数抖动。

---

## 3. 交互与拓扑连接验证 (Functional Tests: Interaction)

### **Test 3.1: P2P 绝对精准落位 (Point-to-Point Alignment)**
- **输入序列**: `Lock(SourcePort)` -> `Snap(TargetPort)`。
- **预期输出**: 源零件移动后的全球位姿，必须使两端口的 Z 轴共线且反向对冲。
- **断言**: `dot(v_source_z, v_target_z) == -1.0` (误差 < 1e-6)。

### **Test 3.2: 自动闭合扫描 (Auto-Snap Auto-Latching)**
- **场景**: 两个多孔梁通过一根销钉连接后，用户通过滑动逻辑将另一个销钉也对准孔。
- **预期输出**: 当间距 < 1mm 时，`TopologyManager` 自动产生第二条 `ConnectionEdge`。

---

## 4. 物理约束与安全性 (Safety & Constraints)

### **Test 4.1: 轴向移动阻连 (Collision Clamping)**
- **动作**: 沿轴滑动零件至发生物理撞击。
- **预期**: 零件停止在撞击点，且 UI 触发红色干涉脉冲高亮。

### **Test 4.2: 非法配合状态拦截**
- **动作**: 尝试连接物理极性冲突的端口（如：销对销、孔对孔）。
- **预期**: 系统展示 **置灰 (Dimmed) 箭头** 且不可点击。
- **断言**: `SiteGizmo.isCompatible == False`。

### **Test 4.3: 动态视觉反馈一致性**
- **场景**: 鼠标悬停在兼容目标上。
- **断言**: `emissiveColor == '#ff9800'` (橙色高亮)。
- **场景**: 沿轴滑动到达物理极限。
- **断言**: `isBlocked == True`, `UI.pulse == Red`。

---

## 5. 质量回归基准 (Regression Baseline)

- **基准零件集**: `32316.dat`, `6558.dat`, `3749.dat`, `2780.dat`。
- **通过准则**: 每次架构重构后，以上零件的 **连接自由度（DOF）** 必须保持与物理真实表现一致。

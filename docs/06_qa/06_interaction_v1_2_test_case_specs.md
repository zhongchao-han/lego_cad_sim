# LEGO CAD 仿真系统：Interaction v1.2 测试用例规格书 (Test Cases)

本文件定义了系统在 Interaction v1.2 阶段必须通过的各类测试场景，作为质量验证的唯一准则。

---

## 1. 几何与对齐单元测试 (Unit Tests: Geometry & Alignment)

### Test 1.1: P2P 精准落位计算 (Point-to-Point Match)
- **输入向量**：
  - Source Port: `pos=[10, 0, 0], rot=Identity`
  - Target Port: `pos=[20, 20, 20], rot=RotateY(180)`
- **预期输出**：计算出的 Transform 矩阵必须使 Source 零件的全球坐标正好落在 Target 端口上，且旋转轴（Z轴）精准重合。
- **断言 (Assertions)**：
  - `distance(final_source_port, target_port) < 1e-4`
  - `dot(source_z_axis, target_z_axis) ≈ -1.0`

---

## 2. 状态机与流程验证 (Integration Tests: FSM & Flow)

### Test 2.1: 阶段跳转一致性 (InteractionPhase Transitions)
- **触发序列**：`Hover(Site)` -> `Click(Arrow)` -> `Click(TargetSite)`。
- **验证点**：
  1. `Hover(Site)` 触发 `GizmoManager.showArrows()`。
  2. `Click(SourceArrow)` 后，`InteractionPhase` 必须跳转为 `SOURCE_LOCKED`。
  3. `Click(TargetSite)` 后，进入 `AXIAL_SLIDING` 直至 `MouseUp`。
- **断言**：阶段流转顺序必须完全符合交互序列图。

### Test 2.2: 钻取选择深度变更 (Selection Drill-down)
- **触发序列**：第一次 `Click(PartA)` -> 再次 `Click(PartA)`。
- **预期输出**：
  - 第一次点击：`SelectionLevel = GROUP`，高亮整个连通子图。
  - 第二次点击：`SelectionLevel = INDIVIDUAL`，仅高亮 PartA。

---

## 3. 物理约束与反馈测试 (Constraint & Feedback Tests)

### Test 3.1: 轴向移动阻连 (Collision Blocking)
- **前提条件**：轴 A 已插入梁孔，且前方有另一零件障碍物 B。
- **动作**：用户沿轴向拖拽轴 A 撞向 B。
- **预期结果**：
  1. `CollisionEngine.testMotion` 返回 `isBlocked: true`。
  2. 零件 A 在撞击点停止位移（Clamped Position）。
  3. 调用 `FeedbackManager.pulseCollision()` 渲染红色脉冲。

### Test 3.2: 过约束自由度锁定 (Over-constraint)
- **前提条件**：梁 B 通过两个平行的销与支架 A 连接。
- **预期输出**：`ConstraintSolver.solveDOF(B)` 返回 `canRotate: true` (绕两销中心轴旋转), `canSlide: true` (沿两销轴向滑动)。
- **变体测试**：如果两个销不平行（如 90 度交错）。
- **预期输出**：`canRotate: false`, `canSlide: false`，旋转 UI 自动隐藏。

---

## 4. 后端数据聚合测试 (Backend Analysis Tests)

### Test 4.1: Site 空间聚合算法 (Site Aggregation)
- **测试原件**：一个复杂的导轨零件，同一坐标处有 3 个不同方向的 Port 原始数据。
- **预期输出**：`analyze_ports.py` 输出的 JSON 中，该位置仅有一个唯一的 `Site ID`，下面挂载 3 个 `Port` 对象。
- **断言**：`len(result_sites) == ExpectedUniquePositions`。

---

## 5. 负面与极端测试 (Negative Tests)

### Test 5.1: 非法配合拦截 (Incompatible Fit)
- **动作**：尝试将一个 “十字轴 (Cross Male)” 强行插入一个 “圆孔 (Round Female)”。
- **预期结果**：接口返回 `BLOCKED`，系统禁止 Snap 操作并弹出红色警示。

### Test 5.2: 操作回滚后的状态一致性 (Abort/Esc)
- **动作**：在拖拽滑动中按 `Esc`。
- **预期结果**：场景位姿瞬间恢复到 `HistoryStack.last()` 状态。
- **断言**：`active_scene_instances` 指向的坐标必须等于原始快照。

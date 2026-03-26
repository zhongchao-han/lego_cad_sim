# LEGO CAD 仿真系统：全链路质量验证协议 (Test Case Specifications v3.1)

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

### **Test 1.3: Site 聚类准度 (Site-Based Clustering)**
- **测试零件**: `6558.dat` (3L 带摩擦销)。
- **逻辑**: 验证 3 个 LDraw 原始点是否被正确聚合为 **3 个独立 Site**。
- **断言**: `len(sites) == 3`, `all(len(s.ports) >= 1 for s in sites)`。

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
- **状态**: <span style="color:green">**[已上线 - 11/11 测试通过]**</span>
- **核心组件覆盖 (`test_auto_latch_scanner.py`)**:
    1. **正向匹配**: `test_single_compatible_site_pair_within_threshold` - 正确识别 1mm 内的相互兼容 Site。
    2. **多点匹配**: `test_two_compatible_pairs_both_within_threshold` - 多重连接位点同时闭合。
    3. **幂等排重**: `test_main_connection_excluded_by_idempotency` - 忽略主 Snap 产生的重复边。
    4. **负向排斥 (语义)**:
        - `test_incompatible_female_to_female_returns_empty` - 排斥 Female-Female。
        - `test_incompatible_cross_to_round_returns_empty` - 排斥 Cross-Round 外形不匹配。
    5. **负向排斥 (空间)**:
        - `test_sites_beyond_threshold_return_empty` - 严格忽略 >1mm 的连接。
        - `test_site_exactly_at_threshold_boundary` - 等于 1mm 边界通过。
    6. **批量挂载 (`TopologyManager.batch_connect`)**:
        - `test_batch_connect_registers_edges_for_existing_nodes` - 成功注册扫描边。
        - `test_batch_connect_skips_unknown_nodes` / `empty_list` - 鲁棒性验证。
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

## 5. 质量回归基准 (Regression Baseline / Integration)

- **基准测试集 (`test_v3_1_full_coverage.py` Section 5.0)**
    - `test_5_0_site_cluster_produces_non_empty_result`: 保证对核心资产进行真实 `site_utils.py` 聚类能够产出有效的 Sites。
    - `test_5_0_peg_hole_fit_baseline`: End-to-End 测试从配置抽取 -> 构建 Port -> `check_fit` -> 判定 `CLEARANCE` 兼容。
- **通过准则**: 每次架构重构后，以上零件 (`32316.dat`, `6558.dat` 等) 的 **连续 Snap 与自动闭路** 必须无缝衔接。

# LEGO CAD Simulation - TODO List

## 1. 核心架构增强 (Core Architecture)

### 1.1 `TopologyManager` 逻辑加固
- [ ] **ROOT 动态迁移**：实现 `set_root(part_id)` 与 `migrate_root(target_id)`，确保 Snap 后地基动态切换。
- [ ] **刚体孔距一致性校验**：在 `connect_ports` 时增加几何间距核验，拦截物理上非法的多端连接。
- [ ] **单零件成组逻辑**：确保所有悬空零件最终必须连通至 ROOT 树。

### 1.2 物理引擎对接深度
- [ ] **摩擦力参数精细化**：根据接口类型（如 `friction_pin`）自动调整 `JointState` 中的阻尼系数。
- [ ] **CCD 自适应调整**：根据零件包围盒大小，动态调节 `ccdSweptSphereRadius`。

---

## 2. 自动化与识别系统 (Automation & Discovery)

### 2.1 `PortDiscoverer` 算法升级
- [ ] **轴向启发式权重**：引入邻近几何法向量权重，辅助判定 Pin/Hole 的主轴方向。
- [ ] **格点异常警报**：识别时若发现非标 LDU 偏离，自动标记零件为 `pending` 状态且降低 `confidence`。
- [ ] **镜像自动填充**：利用 CAD 对称性，自动补全镜像位置的端口位姿。

### 2.2 数据管线优化
- [ ] **多进程识别**：使用 `ProcessPoolExecutor` 加速 `port_discovery.py` 对大型 ldraw 库的扫描过程。

---

## 3. 测试覆盖 (Verification)

### 3.1 单元测试完善
- [ ] **`test_topology.py`**：覆盖多连接合并、闭环检测、ROOT 迁移的回归测试。
- [ ] **`test_port_library_manager.py`**：验证 JSON 读写的线程安全与增量保存逻辑。

### 3.2 CI 集成
- [ ] **GitHub Actions**：配置自动化测试流程，每次 push 对核心数学模块进行回归校验。

---

## 4. 前端交互 (Frontend UX)

### 4.1 复核工作台增强
- [ ] **Ghost Snapping**：在复核零件时即时加载 1L 标准件对比对扣效果。
- [ ] **步进旋转 UI**：提供 180° / 90° 翻转按钮替代矩阵参数编辑。

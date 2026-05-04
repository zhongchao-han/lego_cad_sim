# LEGO CAD 仿真系统：项目待办清单 (TODO)

本清单记录了系统从原型到生产级的演进路径。

---

## ✅ 已完成 (Completed)

- [x] **语义重构**：将所有 `Workbench` 术语统一为更专业的 **`Staging (暂存)`**。
- [x] **后台脚本更名与优化**：
    - `port_discovery.py` -> **`analyze_ports.py`**（提升了轴孔分类精度）。
    - `bulk_import_technic.py` -> **`index_library.py`**（标准化了零件索引流程）。
- [x] **交互设计 1.2 规范**：完成了 Site-Port 拓扑、沿轴滑动、UI 旋转按钮等核心交互的文档设计。
- [x] **核心 Bug 修复**：解决了 6558 长销翻转、主画布/暂存区逻辑冲突、以及 FSM 状态机死锁问题。
- [x] **文档逻辑冲突排查 (v3.0)**：发现了 UI 颜色冲突、Site 抽象层缺失、持久化字段漏写等问题。

---

## ⚠️ 待办：文档与代码一致性修复 (Docs & Code Alignment)
- [x] **UI 颜色与交互反馈逻辑同步**：在产品手册和测试规范中完整定义了极性色（蓝/紫）、交互色（橙色 Source Locked 激活态）以及物理干涉（红脉冲）的反馈机制。
- [x] **持久化架构补充**：在 `Port` 类和 `LDrawPort` 模型中通过 `is_manually_adjusted` 字段标记并在 `ldraw_port_configs.json` 中落盘，保护人类微调数据。
- [x] **Staging Tray 概念清理**：将文档中的“2D/3D 混合托盘”修正为更符合现状的“侧边栏零件暂存列表”。
- [x] **归一化顺序明确化**：确立了 `LDU -> SI (0.0004)` 缩放必须在 `Rx(180)` 坐标系翻转之后执行，以确保 Z 轴对齐逻辑的一致性。

---

## 🚀 正在进行 (In Progress)

### 1. 核心拓扑升级 (Topology Upgrade)
- [x] **Site-Port 数据规范实现**：重构 `ldraw_port_configs.json`，将端口平铺列表升级为 **Site-Based（物理场站）** 方案。
- [x] **后端自动闭环扫描**：实现在单次 Snap 后自动扫描并闭合邻近的位移对齐点。

### 2. 交互系统 1.2 落地 (UX Implementation)
- [x] **3D 方向选择箭头 (Gizmos)**：`SiteGizmo.tsx` 组件已实现，支持彻底去除 Hover 视觉变化、支持 Intent 极性过滤（SOURCE_LOCKED 阶段）、点击锁定目标端口，并集成到 `InteractivePart`。
- [x] **沿轴滑动平平移控制**：实现了 `AXIAL_SLIDING` 交互阶段。用户吸附零件后，按住鼠标即可沿连接轴调节插入深度，支持物理边界限位（+/- 20 LDU）。
- [x] **上下文 UI 旋转面板**：按钮驱动的角度步进调节，并支持 **DOF (自由度)** 自动感知隐藏按钮。
- [x] **Auto-Frame (镜头自动聚焦)**：实现零件选中后的平滑视口对齐动画。

---

## 🛠️ 后续规划 (Project Backlog)

### 3. 机械传动与物理深度 (Mechanical & Physics Depth)
- [ ] **⚙️ 齿轮传动链条相位自动对齐**：在 Snap 时根据齿数比自动计算 Z 轴旋转偏移量，达成精密咬合。
- [ ] **⚙️ URDF 导出器闭环逻辑增强**：支持将 `TopologyManager` 识别的 `closed_loops` 导出为 `Mimic Joints` 或 `Floating Base` 约束。
- [ ] **⚙️ 高精度物理过盈反馈**：基于 `FitType` 驱动 `AXIAL_SLIDING` 阶段的动态阻力感（Haptic/Visual feedback）。

### 4. 生产力与视觉 (Productivity & Visuals)
- [x] **🖼️ 自动化零件缩略图渲染**：`scripts/bake_thumbnails.py` 通过 Playwright 无头驱动 `/generator` 页面，单条命令即可补齐/重烘所有 `.dat` 缩略图，CDN 未收录的自定义零件也能落盘。
- [ ] **🔎 零件搜索与分级目录优化**：实现基于关键词与类别的高效库检索。
- [ ] **⚙️ 结构重力与受力分析**：提供简单的静态质心计算与连接处应力可视化。

### 5. 极致高可用与工业级架构 (High Availability & Industrial Architecture)
- [x] **🚀 渲染层 GC 降本增效 (Frontend GC Abatement)**：`utils/snapMath.ts` 三个热函数（`calculateSnapPose` / `applyGroupDelta` / `calculatePortRotationPose`）改用模块级 scratch pool —— `AXIAL_SLIDING` 阶段每次 pointermove 不再 new ~12 个 Three 对象。`Scene.jsx` PlacementGhost `useFrame` 把 `Plane` + `Vector3` 提到 `useMemo` 复用。新增 `snapMath.test.ts` 19 个回归测试覆盖几何正确性 + 1000 次连发 scratch 不污染 + 返回值非 scratch 引用。
- [ ] **🚀 后端物理锁隔离 (Async/GIL Decoupling)**：剥离 `pybullet.stepSimulation()` 至独立的 `ThreadPoolExecutor` 或进程，杜绝其 CPU 密集型积分计算阻塞 asyncio 导致的 WebSocket 推流断档。
- [x] **🚀 API 强幂等与防重入 (Idempotency Key Strictness)**：`backend/idempotency.py` 内存 TTL 缓存 + Starlette 中间件，所有 mutating POST 接受 `Idempotency-Key` header —— 同 key 同 body 直接回放、同 key 不同 body 返 409。前端 `store.ts` 在 `snapParts` 调用上送 UUIDv4，杜绝 `MultiDiGraph.add_edge` 在网络重放下产生重复幽灵边。契约见 `docs/06_engineering_standards/02_api_and_websocket_contract.md §三`。
- [x] **🚀 WebGL 自动化 E2E 测试 (Canvas E2E Pipeline)**：`@playwright/test` 跑通；`frontend/e2e/canvas_pixel.spec.ts`（X 空画布哨兵，CI 必跑）+ `frontend/e2e/generator_pixel.spec.ts`（Y 已知 part 渲染基线，本地手跑），SwiftShader 软渲染锁定跨平台像素一致性，`ci.yml` 新增 `e2e-pixel-check` job 接入护城河。已有的行为级 spec（`editor_cases.spec.ts`、`interaction.spec.ts`）保留作本地回归。

---

## 📝 备注 (Notes)
- **单一责任原则**：每一步迭代需确保功能极简化、通用化且测试完备。
- **一致性**：时刻保持代码实现与 `docs/technical/` 下的设计文档同步。

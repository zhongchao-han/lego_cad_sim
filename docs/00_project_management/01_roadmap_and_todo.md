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
- [x] **⚙️ 齿轮传动链条相位自动对齐**（v1 / 方案 X）：`backend/category.py` 新增 `extract_tooth_count` 从 LDraw 描述 regex 出齿数（标准齿轮 67/125 命中）；`/api/get_verified_parts` 暴露 `tooth_count` 字段；前端 `utils/gearMath.ts` 提供啮合检测（轴线平行 + 中心距 ≈ (T₁+T₂)/2·module）+ 相位对齐（齿尖指向 partner 中心，最小转动）；`store.ts` snapParts 在 `applyGroupDelta` 后扫描场景齿轮，对 srcGroup 中有齿数的成员自动对齐。22 个 gearMath + 5 个 tooth_count 单测覆盖。**v1 不做**：锥齿轮 / 蜗轮蜗杆 / 齿条 / 多齿轮链超定检测（这些 toothCount 提取失败或几何不满足，自动 noop）。
- [x] **⚙️ URDF 导出器闭环逻辑增强 (v1 / 方案 A+B)**：target spec 锁定 ROS 2 / SDF 1.9。`urdf_exporter.py` 把闭环边的虚构 `<gazebo><plugin>` 替换为合规 `<gazebo><joint>`（含 type/parent/child/pose/axis），让外部 simulator 真能加载闭环约束。新增齿轮对 `<mimic>` 自动注入：扫描 spanning tree 中 child 含 tooth_count 的 continuous joint，复用 L44 mesh 几何检测找配对，给 follower 加 `<mimic joint multiplier offset>`，multiplier=-T₁/T₂（外啮合反向）。`PartNode` 新增 `ldraw_id`，`SnapRequest` 新增 `parent/child_ldraw_id`（向后兼容），前端 store 在 snap_payload 携带，server.py 落到 PartNode 并同步 `global_transform`。**顺手修了 pre-existing bug**：`build_spanning_tree` BFS 在 `add_edge` 自动建 neighbor 节点时丢 PartNode data（旧 link export 的 `getattr` 默认值掩盖了它），L45 mimic 检测必须修。新增 7 个 urdf_exporter 单测覆盖闭环 SDF 字段 / 齿轮 mimic multiplier / 距离不匹配 / 轴线垂直 / 共轴 / 缺 ldraw_parts_dir 退化。**v1 不做**：Floating Base / 4-bar 等非齿轮闭环 / 跨 axle-中介齿轮链 / `depth=insertion_depth` 参数（pre-existing bug 单独 issue）。
- [x] **⚙️ 高精度物理过盈反馈 (v1 / 方案 X)**：前端 `utils/fitMath.ts` 把 `backend/port_semantics.py` 的 INTERFACE_REGISTRY + check_fit + 前缀模糊匹配整套复刻一份（避开 AXIAL_SLIDING 高频按键路径上的 `/api/check_fit` round-trip）。`useKeyboardShortcuts.ts` 方向键步长按 FitType 动态缩放：CLEARANCE × 1.0、FRICTION × 0.25（4 倍按键才走 1 LDU）、INTERFERENCE × 0.1、BLOCKED/INCOMPATIBLE × 0（锁死）。Shift 仍 10× 不动，与 fit factor 相乘。`StatusBar.tsx` 在 AXIAL_SLIDING 阶段显示当前 fit 标签（⚪ Loose / 🟡 Friction / ⛔ Blocked）让用户知道为什么慢。22 个 fitMath 单测 + 同源 drift 哨兵（核心 pin↔peghole / fric_pin↔peghole / axle↔axlehole 配对必须正确）。**v1 不做**：振动/音效 / Web Vibration / Gamepad rumble / 真 PyBullet 物理积分（高风险，超 v1 边界）/ INTERFERENCE 单独一档（当前 backend 把它合到 FRICTION，要分需 backend 改 check_fit）。

### 4. 生产力与视觉 (Productivity & Visuals)
- [x] **🖼️ 自动化零件缩略图渲染**：`scripts/bake_thumbnails.py` 通过 Playwright 无头驱动 `/generator` 页面，单条命令即可补齐/重烘所有 `.dat` 缩略图，CDN 未收录的自定义零件也能落盘。
- [x] **🔎 零件搜索与分级目录优化**：`backend/category.py` 启发式从 .dat 首行注释推断 16 类（Pin/Axle/Connector/Beam/Gear/Wheel/Plate/Tile/Brick/Panel/Cylinder/Pneumatic/Steering/Electric/Sticker/Other），1942 个 part 真实分布约 16% 落 Other。`/api/get_verified_parts` 与 `sync_meili.py` 同时注入 `category` 字段（Meili 也加进 `filterableAttributes` 供后续 facet 过滤）。前端 `PartLibraryPanel.tsx` 重写为可折叠分级面板：顶部 ★ Frequent（会话使用 + HIGH_PRIORITY）默认展开，其余 category 默认折叠避免视觉过载，每桶带计数。新增 13 个 categorize 单测覆盖优先级（"Axle Pin" → Pin 不进 Axle）。
- [x] **⚙️ 结构重力与受力分析（v1 = A+B+C 质心 + 稳定性）**：(A) 后端 `mass_estimator.py` 用 `trimesh.volume × ABS_DENSITY (1050 kg/m³)` 估算单零件 mass + COM；非 watertight mesh 走 bbox × 0.5 fallback；`/api/get_verified_parts` 注入 `mass_kg` + `com_local`；lru_cache 摊销 IO。(B) 前端 `utils/staticsMath.ts` 整体质心 = mass-weighted average of part.position；`CenterOfMassGizmo.tsx` 红/绿三轴十字 + 中心球，仅 ASSEMBLY 模式 ≥1 part 时显示。(C) Footprint = **Y 最低集合**（contact tolerance 1 LDU）的 part position 在 XZ 平面凸包（monotone chain）；稳定 ⇔ COM 投影 ∈ footprint。区分支撑点 vs 悬空点是稳定性判定的核心 —— 若 footprint 含全部 part position，COM 作为凸组合永远落 hull 内，判定永真。StatusBar 加 "🟢 Stable" / "⚠ Unstable" 标签，gizmo unstable 时变红。10 个 mass_estimator + 21 个 staticsMath 单测。
- [x] **L51b PR-A：part-local COM 修正 + bbox 最低 vertex footprint**（推自 L51 v1）：staticsMath 的 `StabilityPart` 接 `quaternion` / `comLocal` / `bboxSize` / `bboxCenter`。⑤ 整体 COM 改为 `R_world · com_local + position` 加权累计 —— 偏心零件（电机壳、大齿轮）质心反映准确。④ Footprint 改为每 part 取 8 bbox 角点 → 转世界 → 取 Y-min 集合 → XZ 凸包，扁平大盘的真实支撑面被还原（v1 仅 part.position 单点，假阳性严重）。后端 `/api/get_verified_parts` 注入 `bbox_size` + `bbox_center`（直接读 port_lib_manager 持久化的 cached_data）。`PartCatalogEntry` 新增对应字段。模块级 scratch 池（_q / _v）避免 useMemo 重算时 alloc。新增 5 个 staticsMath 单测覆盖 ⑤ 旋转/退化 + ④ 扁平盘 footprint。
- [x] **L51b PR-B：反力求解 + 反力可视化**（推自 L51 v1）：① 后端 `statics_solver.py` 用 `numpy.linalg.lstsq` 解 N 零件 6 平衡方程（Σ F=0、Σ τ=0）+ 6 ground anchor 锚定 Y 最低零件，输出每条 ConnectionEdge 的 6D wrench (Fx Fy Fz Mx My Mz)。`/api/compute_reactions` 端点用 `asyncio.to_thread` 走 L55 物理锁隔离同模式，避免阻塞主循环。② 前端 `ReactionForceVisualizer.tsx` 在每条 edge 的 anchor_world 画一支彩色箭头：起点 = wrench 作用点；方向 = force 单位向量；长度 = 固定 12mm；颜色 = magnitude HSV log scale 映射（绿→黄→红）。store 加 `reactionForces` map + `showReactionForces` toggle + `refreshReactionForces` async action（debounced 走 useEffect on connections 变化）。StatusBar 加 ⇡ Forces 切换按钮。7 个 statics_solver 单测覆盖空图 / 单零件 grounded / 链式重力增量 / 闭环鲁棒性 / mass_provider 回调 / 输出 shape。**v1b 简化**：所有 edge 当 6 DOF fixed joint 处理（joint-type-aware 释放轴向自由度留 v2）；以 part origin 当重力作用点（com_local 修正留 v2）。
- [x] **L51b PR-C：真应力 von Mises 近似**（推自 L51 v1）：③ 后端 `stress_analysis.py` 把 PR-B 的 reaction force 投到 port_parent 圆截面：`F_axial = F · axial_world_dir`、`F_lateral = ‖F − F_axial · axial‖`，`σ = |F_axial|/A`、`τ = F_lateral/A`，σ_vm = `√(σ² + 3·τ²)` (plane-stress distortion-energy 准则)。ABS 屈服 40 MPa 中值，`safety_ratio = σ_vm / σ_yield`；`yields = ratio ≥ 1`。仅 `Profile.CYLINDER` 适用（CROSS / STUD / 缺接口 → null），`enrich_reactions_with_stress` 给 `/api/compute_reactions` 响应批量补 `stress` 字段。前端 `ReactionForceVisualizer` 优先按 `safety_ratio` 着色（120° 绿 → 0° 红 + 屈服深红），无 stress 回退到 raw magnitude HSV。StatusBar 加最严重 stress 警示（`>= 0.7` 黄字 caution、`>= 1.0` 红字闪烁 "Yielded"）。11 个 stress_analysis 单测覆盖纯轴向拉/压 / 纯横向剪 / 3-4-5 组合分解 / 父零件旋转后 axial 跟着转 / 屈服阈值精确边界 / CROSS profile None / 旋转矩阵退化 / 端到端 enrich。**v1b 简化（明确）**：(a) 圆截面均匀分布剪应力（真值 τ_max = 4F/(3A)，省 4/3 系数）；(b) 不算 torque 引发的 σ_torsion（`M·r/J`，LEGO 销受扭量级远低于轴向，留 v2）。**Honest 边界**：玩具语境下 LEGO 装配常态使用极少触屈服，本截价值偏教育性 —— 给做工程模型的高级用户看"哪根销开始吃力"。

### 5. 极致高可用与工业级架构 (High Availability & Industrial Architecture)
- [x] **🚀 渲染层 GC 降本增效 (Frontend GC Abatement)**：`utils/snapMath.ts` 三个热函数（`calculateSnapPose` / `applyGroupDelta` / `calculatePortRotationPose`）改用模块级 scratch pool —— `AXIAL_SLIDING` 阶段每次 pointermove 不再 new ~12 个 Three 对象。`Scene.jsx` PlacementGhost `useFrame` 把 `Plane` + `Vector3` 提到 `useMemo` 复用。新增 `snapMath.test.ts` 19 个回归测试覆盖几何正确性 + 1000 次连发 scratch 不污染 + 返回值非 scratch 引用。
- [x] **🚀 后端物理锁隔离 (Async/GIL Decoupling)**：`PhysicsEngine` 内部用 `threading.Lock` 串行所有公有方法（pybullet client 非线程安全的硬约束）；`server.py` WebSocket loop 与 `apply_force` / `toggle_mode` 路由全部把 engine 调用挪到 `asyncio.to_thread`，HTTP 路由不再被物理积分冻结。新增 `reset(mode)` 方法替代旧 `engine.__init__()` 复用 hack（旧写法会替换锁让 in-flight 调用拿孤儿锁）。3 个并发回归测试覆盖：多线程 hammer 不崩 / reset 与 worker 串行不竞态 / to_thread 显著降低 asyncio 主循环阻塞（实测 ~1.5× yield tick；上限受 pybullet 部分持 GIL 限制，要全解需 Option C 子进程）。
- [x] **🚀 API 强幂等与防重入 (Idempotency Key Strictness)**：`backend/idempotency.py` 内存 TTL 缓存 + Starlette 中间件，所有 mutating POST 接受 `Idempotency-Key` header —— 同 key 同 body 直接回放、同 key 不同 body 返 409。前端 `store.ts` 在 `snapParts` 调用上送 UUIDv4，杜绝 `MultiDiGraph.add_edge` 在网络重放下产生重复幽灵边。契约见 `docs/06_engineering_standards/02_api_and_websocket_contract.md §三`。
- [x] **🚀 WebGL 自动化 E2E 测试 (Canvas E2E Pipeline)**：`@playwright/test` 跑通；`frontend/e2e/canvas_pixel.spec.ts`（X 空画布哨兵，CI 必跑）+ `frontend/e2e/generator_pixel.spec.ts`（Y 已知 part 渲染基线，本地手跑），SwiftShader 软渲染锁定跨平台像素一致性，`ci.yml` 新增 `e2e-pixel-check` job 接入护城河。已有的行为级 spec（`editor_cases.spec.ts`、`interaction.spec.ts`）保留作本地回归。

---

## 📝 备注 (Notes)
- **单一责任原则**：每一步迭代需确保功能极简化、通用化且测试完备。
- **一致性**：时刻保持代码实现与 `docs/technical/` 下的设计文档同步。

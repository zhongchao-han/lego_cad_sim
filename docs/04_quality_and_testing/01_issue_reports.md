# LEGO CAD 仿真系统：质量核验问题报告 (Issue Report v3.1)

## 1. 环境联调问题：CORS 跨源拦截 (Blocked by CORS Policy) - [已修复 ✅]

### **现象描述**
在执行浏览器端全链路测试时，前端（通常运行在 `http://localhost:5173` 或 `5174`）尝试调用后端 API（`http://127.0.0.1:8000`）获取零件库列表。由于后端 `CORSMiddleware` 的 `allow_origins` 列表中未包含当前前端运行的确切端口（如 `5174`），导致浏览器出于安全策略拦截了所有 AJAX 请求。

### **受影响的功能**
- **零件库预览**: "No verified parts found"，无法从库中引入零件。
- **库核验页面**: 零件列表加载失败 (`TypeError: Failed to fetch`)。
- **零件吸附 (Snap)**: 因无法获取预览零件，无法进行全流程验证。

### **复现步骤**
1. 启动后端：`python -m backend.server`
2. 启动前端：`npm run dev`（若 5173 被占用，Vite 会自动切换到 5174）
3. 打开控制台，观察 `api/get_verified_parts` 报错：`Access to XMLHttpRequest has been blocked by CORS policy`.

### **修复状态**
已在 `backend/server.py` 中更新 `allow_origins`，支持 `localhost:5174`。经过浏览器实测，Material Library 现在能正常加载零件列表。

## 2. 交互与拓扑 (待验证项)
由于 CORS 阻塞，以下 Test Case 尚未能通过自动化浏览器脚本完成：
- **Test 3.1: P2P 绝对精准落位**
- **Test 4.1: 轴向移动阻连**
- **Test 4.3: 动态视觉反馈一致性**

---

## 3. 上下文旋转的"刚体子组"语义偏差 - [基础修复 ✅ / 部分遗漏待办 ⚠️]

### **现象描述**
在 `SOURCE_LOCKED` / `AXIAL_SLIDING` 阶段按 `[` / `]` 触发 90° 旋转时，旋转作用范围反复出错。三轮反馈：

1. **v1 现象 (insufficient)**: 灰板上插了销、销又被点为 source 触发旋转 — 销飞走了，灰板留在原地，连接图与几何状态撕裂。
2. **v2 现象 (over-reaching)**: 把"整个连通分量"作为旋转域 — 灰板和它对面的红板（通过销相连）一起转，违反 Case 3.4「地基不动」原则。
3. **v3 现象 (anchor missed)**: 用 `occupiedPorts[partId][portKey(...)]` 严格匹配查询 peer，由于 §5.1「贯通孔双面分裂」规则，同一物理 connhole 在元数据里是两个**法向严格相反**的端口对象（销从上面插 vs 从下面插）。snap 时占用记录的是"销实际对接的那一面"；用户旋转时点击的若是孔的**对偶面**，portKey 命中不上，退回 `anchor=none`。

### **修复路径**
最终方案：在 `rotateSelectedPart` 里做"对偶面容差查询"——扫描 `occupiedPorts[partId]`，找位置距离 selectedPort.position 在 `TOL=0.02` LDU 内、且 Z 法线**同轴**（dot ≈ ±1）的占用项作为锚点 peer。该 peer 从 BFS 中排除，得到的 `srcGroup` 整体绕 selectedPort 的 Z 轴一起旋转。详见装配算法规范 §6。

### **复现验证**
- **Test R.1**: 灰板上一孔已接销→红板，点该孔旋转 → 灰板自转，销+红板纹丝不动；日志 `anchor=<销ID>`。
- **Test R.2**: 销已插灰板，点销另一端旋转 → 销带灰板飞，红板侧不动；日志 `anchor=<对面peer>`。
- **Test R.3**: source 是孤岛（无连接），旋转 → `anchor=none`，整组（即 source 自己）旋转。

### **v4 现象 (over-constraint leak)**
v3 修复后用户实测：灰板上 ≥2 个销同时插着红板，单一 anchor 销被 BFS 排除后，BFS 仍能从其他销路径到达红板 → srcGroup 包含红板 → 红板被一起转。这是 **Case 4.1 过约束**场景的真实触发。

### **修复路径 (v4 → v5)**
**v4 (cut vertex)** 实施后被 user 测试出误报：拓扑只剩"灰板 + 一个叶子销"时，去掉销不影响 component 数，cut vertex 定义不成立 → v4 不应触发，但因为 `srcGroup.length === fullGroup.length - 1` 公式对叶子节点也成立（叶子去掉后剩下的 N-1 个节点仍构成 1 个 component），导致误判。

**v5 (one-hop closure，当前实现)**：合法旋转域 = `{source} ∪ source 的直接邻居`；srcGroup 必须 ⊆ 合法域。任何溢出（即 source 的二阶或更远连接）即过约束。该算法对所有历史场景（v1 销带板飞、v2 多销并联、叶子 anchor）都给出正确判定，详见装配算法规范 §6.2 第 4 步算法选型对比。

### **复现验证 (补充)**
- **Test R.4 (过约束 negative)**: 灰板通过 2 个销同时插红板，点灰板某孔旋转 → log: `[Rot] 过约束锁死：source ... 经其邻居二阶连到 [...]，旋转会拽动这些非锚定零件...`，灰板和红板都不动。
- **Test R.5 (过约束解锁)**: 删除 R.4 中所有"跨板销"（仅留连灰板的叶子销）→ 再次旋转 → 灰板正常自转，叶子销跟着转，红板纹丝不动。
- **Test R.6 (叶子 anchor 不应误报)**: 灰板 + 1 个只挂在灰板上的叶子销，红板独立放置（不连任何销）→ 旋转 → 灰板自由绕销转，无 ERROR log。

### **已知遗漏 (Open Items)**
1. ~~**AutoLatch 边集未回流前端 (高优先级)**~~ — **[已修复 ✅]**：`/api/snap_parts` 响应新增 `auto_latched_edges: [{src_part_id, dst_part_id, src_port_key, dst_port_key}, ...]`，由 `backend/auto_latch_scanner.py::serialize_port_key()` 生成与前端 `store.ts::portKey()` 逐字符一致的 key（含负零归一化）。前端在 `axios.post(/api/snap_parts)` 的 then 回调里把每条边幂等地并入 `connections` 与 `occupiedPorts`，并在 `snapPreState` 仍在场时追加到其 `addedConnections` / `addedPortKeys`，使 SnapCommand 的 undo 能一次性回滚整组（包括 AutoLatch 闭合的对扣边）。罕见竞态（用户在 axios.then 之前就触发 commitAxialSliding）下退化为"只更新当前状态、不进入 undo 栈"，AutoLatch 边在状态里仍持续存在；后续删除任一相关零件时会通过 stagePart/deletePart 的级联清理走正常路径。覆盖测试见 `frontend/src/__tests__/store_snap_api.test.ts`（合并 / undo 追加 / 幂等）与 `backend/tests/test_auto_latch_scanner.py::TestSerializePortKey`（前后端 portKey 一致性）。
2. **TOL 阈值是单点观察硬编码 (低优先级)**: `0.02` LDU 来自 71709 板（孔间距 0.032、板厚差 0.008）。对孔距 < 0.04 的更紧凑零件可能误匹配相邻孔。根治方案是把 connection edge 升级为带端口标签的有向边（`{srcPortKey, dstPortKey}`），peer 查询直接 O(1) 准确，不靠浮点容差。
3. **过约束 UX 待补 (低优先级)**: v4 仅在 log 里输出 ERROR，UI 上没有 spec Case 4.1 要求的"锁死图标"或浮动提示。功能正确但可发现性差。

---

## 4. UI 测试覆盖工作 Round 1 (B5/C7-10/D3-5/E3) — 12 项发现 audit log - [已立 issue 跟踪 ✅]

### **概述**
2026-05 一轮 UI e2e 测试覆盖工作（PR #57/#58/#59/#60，落地 TS-7 连续图章 / C7 Esc 复合 / C8 输入框焦点屏蔽 / C10 Marquee / D3 view 切换 / D4 mode 切换 / D5 ContextLost / E3 localStorage reload）在写 e2e 时反向暴露 12 项发现：3 项真 bug、4 项测试设计/老测试问题、5 项架构异味。绝大多数**未修**，仅做记录 + 立 issue 跟踪。

---

### **A. 真 bug（产品代码错） — 各立独立 issue**

#### A.1 — Esc 双 handler 竞态（[issue #61](https://github.com/zhongchao-han/lego_cad_sim/issues/61)）
- **现象**: FREE_PLACING + Esc 偶尔留下 `interactionPhase==='IDLE'` 但 `freePlacingPayload.length===1` 的中间态。
- **根因**: 两个独立 keydown handler 监 window 上的 Escape：
  - `frontend/src/Scene.jsx:367` — `commitFreePlacing(undefined)`（finalize 语义）
  - `frontend/src/hooks/useKeyboardShortcuts.ts:104` — `abortCurrentInteraction() + deselectAll()`（abort 语义）
  顺序由 DOM addEventListener 时序决定，且语义冲突。
- **测试侧 workaround**: `editor_cases.spec.ts` TS-5 在 #58/#59 全部改 `expect.poll(5s)`；#60 仍 timeout，最终在 CI 加 `test.skip(!!process.env.CI)` 引用本 issue。
- **历史**: TS-5 在 #57 round 1 过 → #57 round 2 flaky → #58 3-retry 全挂。单调恶化趋势。

#### A.2 — `/api/snap_parts` axios fire-and-forget 缺 .catch（[issue #62](https://github.com/zhongchao-han/lego_cad_sim/issues/62)）
- **现象**: 后端不在时浏览器 console 每次 snap 都打 unhandled promise rejection。
- **根因**: `frontend/src/store.ts:804-806` `axios.post(...).then(...)` 没接 .catch。设计上 fire-and-forget 是 OK 的（本地 set 已生效，UI 不依赖响应），但缺 .catch 是疏忽。
- **影响**: CI e2e 靠 `page.route` mock 屏蔽；生产环境后端短暂掉线时同样会刷屏。

#### A.3 — `toggleMode` 失败被 try/catch 静默吞（[issue #63](https://github.com/zhongchao-han/lego_cad_sim/issues/63)）
- **现象**: 切换 ASSEMBLY ↔ SIMULATION 失败时 store 不更新、UI 无任何提示，用户只看到点击没反应。
- **根因**: `frontend/src/store.ts:432-441` 仅 addLog，不设 store error 字段，UI 无订阅入口。
- **影响**: 仿真模式切换是 high-stakes 操作，静默失败掩盖系统层问题；#59 D4 反向 baseline 跳过的直接原因（无法严格区分"未变化" vs "toggle 失败"）。

---

### **B. 测试设计 / 老测试问题**

#### B.1 — TS-7 命名错位（已闭 ✅ — 删除老测试，issue #95）
- **现象**: `frontend/e2e/editor_cases.spec.ts:362` 旧 "TS-7: Display Ports on Hover Without Crash" 跟规范 `docs/EDITOR_TEST_CASES.md` TS-7（连续图章）完全无关——测的是 hover 不崩。
- **修复状态**: #57 新增的连续图章 e2e 命名 `TS-7-ContinuousStamp` 消歧义；老命名 #95 走 option 3 删除（CI 永远 skip = 0 实际保护；hover 状态机由 vitest 5+ 单测覆盖：`useHoverDebounce` / `useHoverState` / `hoverInteraction` / `pureGeometricHover` / `store_setHoveredPort`；组件不崩由 `InteractivePartRender` 担保）。

#### B.2 — 老 TS-7 hover-crash 在 CI 不可救（已闭 ✅ — 删除老测试，issue #95）
- **现象**: 测试用真 LDraw `6558` + `simulateHumanJitter(3s)`；CI 上 backend 没起 → R3F 几何加载链路 hang + WebSocket 重试洪流 → event loop 拖到 30s test timeout 三次 retry 全挂。
- **修复状态**: #57 round 2 加 `test.skip(!!process.env.CI, ...)`；#94 round 1/2 试加 LDraw mock + WebSocket stub 仍 timeout（R3F + SwiftShader 软渲染重）；#95 收口走 option 3 删测试 + 删 `frontend/e2e/utils/mouseBehavior.ts`（仅被该测试用）。WebSocket / LDraw mock 基础设施保留供其他 e2e 用。

#### B.3 — `e2e-editor-cases` job 命令是文件名 grep（已修复 ✅）
- **现象**: PR #57 落地的 CI job 用 `npx playwright test editor_cases`——是文件名 grep filter，新加的 `editor_keyboard_marquee.spec.ts` 等无法被抓。
- **修复**: PR #58 改成 `--grep-invert "Canvas pixel sentinels|Generator pixel rendering"`，job 改名 `e2e-non-pixel`。后续新 spec 自动接入，无需改 CI。

#### B.4 — TS-5 baseline 写死 `expect(...).toBe(...)`（部分修复 ⚠️）
- **现象**: 多次 hard `expect(payload.length).toBe(0)` 在 React batching + Esc race 收敛慢的 CI 必 flaky。
- **修复**: #58/#59 全部改 `expect.poll(5s)`；#60 仍偶发 5s 不够，CI skip 引 issue #61。**根因仍在产品侧**（A.1）。

---

### **C. 架构异味 — umbrella [issue #64](https://github.com/zhongchao-han/lego_cad_sim/issues/64)**

5 项不阻塞功能、但都在"未来某次重构会咬人"位置的设计层面问题，集中跟踪：

#### C.1 — 多 handler 同时监 window keydown，顺序敏感
- `App.jsx:132` Cmd+K/Esc / `Scene.jsx:367` Esc / `useKeyboardShortcuts.ts:104` Esc 兜底——三处独立 `window.addEventListener('keydown', ...)`，优先级靠声明顺序 + `e.preventDefault()` 不阻 propagation。新加 handler 极易引入 race（A.1 即此）。
- **建议**: 集中到 reducer 风格的 keymap dispatcher，context-aware 路由。

#### C.2 — `isContextLost` vs `setContextLost` 命名不对称
- `frontend/src/store.ts:114/179` state 字段带 `is` 前缀，setter 不带。typo cost。
- **建议**: 统一约定（同保留 `is*` 或同去掉）。

#### C.3 — `view` 与 `mode` 共用 'ASSEMBLY' literal — [已修复 ✅]
- `frontend/src/store.ts` 原本：
  ```ts
  mode: 'ASSEMBLY' | 'SIMULATION';      // 物理仿真状态
  view: 'ASSEMBLY' | 'LIBRARY_VERIFY';  // UI 视图（已重命名）
  ```
  语义完全不同但共用同一字符串值，TypeScript 无法捕（都是 string literal union）。
- **修复**: 已重命名 `view: 'EDITOR' | 'WORKBENCH'`（改 view 比改 mode blast radius 小，后端 `/api/toggle_mode` 仍接收 'ASSEMBLY'/'SIMULATION'，不动后端契约）。`mode` 字面值保留。13 处替换 + e2e D3 测试同步更新。

#### C.4 — 持久化字段隐式契约
- `frontend/src/store.ts:1720` `partialize` 手写白名单 7 个字段。新加 store 字段忘记加进去 → reload 后悄悄丢失，无任何编译/运行时检查。
- **建议**: 抽 `type PersistedFields = Pick<StoreState, ...>` 让 store 接口和 partialize 共享，新加字段被强制做"持久化决策"。

#### C.5 — 多组件用 R3F Canvas，`page.locator('canvas')` 不可靠
- `App.jsx:156`、`VerificationWorkbench.tsx:5+`、`PartLibraryPanel` 缩略图都用 R3F Canvas。`canvas` 全局至少匹配一个，无法用计数判 view 状态（D3 e2e 第一版踩坑）。
- **建议**: 给主 Canvas 加 `data-testid="assembly-canvas"`；e2e 用 testid 精确定位。

---

### **测试侧产物**
本轮工作除暴露问题外，落地的 e2e 资产（已 merge 到 main）：

| ID | 用例 | spec 文件 |
|---|---|---|
| TS-7 | 连续图章 7.1/7.2/7.3 | `frontend/e2e/editor_cases.spec.ts` |
| C7-EscCompound | Cmd+K 开搜索 / Esc 关 + 清 selection | `frontend/e2e/editor_keyboard_marquee.spec.ts` |
| C8-InputFocusGuard | input 焦点屏蔽 F/Delete/Cmd+C | 同上 |
| C10-MarqueeShiftDrag | Shift+drag 框选（命中失败 fallback） | 同上 |
| D3-ViewSwitch | ASSEMBLY ↔ LIBRARY_VERIFY 可逆 | `frontend/e2e/editor_view_mode_context.spec.ts` |
| D4-ModeToggle | toggleMode + 三项交互态清空 | 同上 |
| D5-ContextLost | webglcontextlost + UI 覆盖层 | 同上 |
| E3-LocalStorageReload | zustand persist 端到端 | `frontend/e2e/editor_persistence.spec.ts` |

CI 基础设施加固：`e2e-non-pixel` job grep-invert 自动抓所有非像素哨兵 e2e（#58）。

### **未覆盖项（待 Round 2）**
按用户矩阵编号清单仍欠：A2 / A4 / A5 / A6 / A7 / C9 / F2 / F3 / F4。下轮启动前应优先消化本节 A.1 - A.3 的真 bug，避免新一轮测试再触达同一个 race。

---

## 5. UI 测试覆盖工作 Round 2-4 + 真 bug 闭环 (2026-05) - [全部已修复 ✅]

### **概述**
延续 §4 的覆盖工作，完成矩阵清单剩余 + 全仓审计 + 真 bug 全部修复 + 后端覆盖追平。

### **Round 2：UI e2e 矩阵清单完结 + Top 4 unit 主线**
- 矩阵剩余完整覆盖：A2 sliding / A4 override (skip 引 #66) / A6 旋转 / A5/A7/C9 单测 / F2 F3 F4 搜索+库
- 全仓 audit Top 4 unit 主线：
  - rotateSelectedPart 11 case + abortCurrentInteraction 8 case (PR #70)
  - analyzeStability 边界 + 退化 footprint 9 case (PR #71)
  - setHoveredPort 9 case + useKeyboardShortcuts 16 case (PR #72)

### **Round 3：审计补遗**
- commitAxialSliding cp 分支 + SnapCommand undo/redo round-trip 11 case (PR #74) — 反向暴露 [#73 redo 不重建](https://github.com/zhongchao-han/lego_cad_sim/issues/73)
- verificationStore 12 case + useLDrawPart 7 case (PR #76) — 反向暴露 [#75 clearPartCache 前缀](https://github.com/zhongchao-han/lego_cad_sim/issues/75)
- handlePortClick 分支 + pasteClipboard 中心 + selectPart 14 case (PR #77)
- partColorDefaults 7 case (PR #78)

### **Round 4：后端覆盖追平**
- `backend/physics_engine.py` 真 pybullet DIRECT mode 18 case (PR #88) — 反向暴露 [#87 p.JOINT_CONTINUOUS 不存在](https://github.com/zhongchao-han/lego_cad_sim/issues/87)
- `backend/urdf_exporter.py` export() 边界 8 case (PR #89)
- `backend/server.py` insertion_check + apply_force + WebSocket physics_stream 12 case (PR #90)
- `frontend/src/hooks/useHoverDebounce.ts` 7 case (PR #91)

### **真 bug 修复全部闭环**

| Issue | 修复 PR | 修法摘要 |
|---|---|---|
| [#61](https://github.com/zhongchao-han/lego_cad_sim/issues/61) Esc 双 handler 竞态 | #83 | Scene.jsx 删 keydown handler，统一到 useKeyboardShortcuts 按 phase 分发 |
| [#62](https://github.com/zhongchao-han/lego_cad_sim/issues/62) snap_parts 缺 .catch | #80 | audit false positive — `.catch` 早在 commit 76d4f502 加上，PR 仅 regression lock |
| [#63](https://github.com/zhongchao-han/lego_cad_sim/issues/63) toggleMode 静默吞 | #84 | store 加 `modeToggleError` 字段 + `modeToggling` 防双击；UI 集成 follow-up |
| [#66](https://github.com/zhongchao-han/lego_cad_sim/issues/66) calculateClampedOffset 死代码 | #82 | snapParts / updateSlideOffset 透传 shiftKey；A4-ShiftOverride unskip |
| [#73](https://github.com/zhongchao-han/lego_cad_sim/issues/73) SnapCommand redo 不重建 | #81 | commitAxialSliding capture addedPartStates；redo 用完整 PartState 重建 |
| [#75](https://github.com/zhongchao-han/lego_cad_sim/issues/75) clearPartCache 前缀误删 | #79 | `startsWith(partId+'_')` 严格前缀，避免 "3001" 误清 "30015_*" |
| [#87](https://github.com/zhongchao-han/lego_cad_sim/issues/87) p.JOINT_CONTINUOUS 不存在 | #88 | URDF parser 把 continuous 归 REVOLUTE，移除 invalid 引用 |

**架构小锐**（umbrella [#64](https://github.com/zhongchao-han/lego_cad_sim/issues/64)）：
- C.3 view 字面值 'ASSEMBLY'→'EDITOR'/'WORKBENCH' (PR #86) — 消除跟 mode 的字符串重叠
- C.5 主 R3F canvas 加 `data-testid="assembly-canvas"` (PR #85) — D3 e2e 双重断言改用 testid

### **CI 上 skip 解锁**
所有 quirk-lock 测试都已取消 skip / quirk 标记，回归正常断言：
- TS-5 Free Placing Paste（#83 修 Esc race 后 unskip CI）
- A4-ShiftOverride（#82 修 calculateClampedOffset 后 unskip）
- store_commit_undo case 8（#81 修 redo 后取消 quirk）
- useLDrawPart case 6（#79 修前缀后取消 quirk）

### **未取消的 skip**
0 个 — `editor_cases.spec.ts` TS-7 hover-crash 在 issue #95 走 option 3 整体删除（详见 §B.1 / §B.2）。

### **整体测量**
- 17 个 PR merged（#57-91）
- 7 个 bug issue + 1 umbrella + 1 follow-up
- 35 个 vitest test files / 410+ unit test 总数
- 8 个 e2e spec 文件 / 25+ e2e test
- 后端：18 case physics_engine + 8 case urdf_exporter 边界 + 12 case server 三 endpoint

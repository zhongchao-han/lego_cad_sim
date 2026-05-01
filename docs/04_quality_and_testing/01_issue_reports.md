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

# Plug 抽象 — 手动 smoke 测试用例

走法 A 全段（A1 + A2 + B 期 6 PR）落地后的真浏览器 smoke 清单。CI 跑的是 port-level 路径 + 单元测试；本文档的 5 个 case 是 **PLUG 模式视觉 + 交互**的人工验证。

## 起服务

```powershell
.\start_dev.ps1
```

打开 http://localhost:5173

## 数据集说明（重要）

这套数据集是 **Technic 系列**为主（销 / 梁 / 齿轮等），**没有经典 LDraw 2x4 plate（3020/3022/3023）**。下面用例用真实可用的 Technic part：

| Part | 描述 | 端口 | plug | 用途 |
|---|---|---|---|---|
| **40490** | Technic Beam 9（9 孔梁）| 18（顶 9 + 底 9 贯通）| **1**（双面合并）| hover halo / 整片选 |
| **2780** | Technic Pin（带摩擦销）| 2 | **2**（头 / 尾分开）| 销头 plug snap |
| **170** | Technic Gearbox 20:1 Casing | 8 | **2** | 多 plug 选择 |
| **32524** | Technic Beam | 14 | 1 | 备选 hover halo |
| **32525** | Technic Beam | 22 | 1 | 备选大 beam |

## 共同的 stale state 清理

如果 StatusBar 显示的 part 数跟场景实际不符（例如场景空但 `Parts: 1`），多半是上次跑出过 GLB bake 失败留下的幽灵 part。`parts` 字段是持久化的，会跨 reload。**清干净**：

```js
// 浏览器 DevTools console
localStorage.clear(); location.reload();
```

reload 后场景应该真空 → `Parts: 0` / `Free: 0` / 无 plug 显示。

## 搜索框（Cmd+K）的关键词

LDraw 原生命名带空格 + Technic 部件号偏数字，所以**搜部件号最稳**：

| 搜 | 命中 |
|---|---|
| 部件号 `170` / `2780` / `40490` / `32525` | ✅ 精确 |
| 类目 `beam` / `pin` / `gear` / `plate` / `brick` | ✅ 描述匹配 |
| `Technic Beam 9` | ✅ 描述匹配 |
| `2x4`（不带空格）| ❌ 0 hits — Meili tokenizer 不拆数字+x |
| `3020` / `3022` | ❌ 0 hits — 不在 Technic 数据集 |

历史坑（已修）：`backend/sync_meili.py` 之前误把 `LDRAW_PARTS_ROOT` 当 `parts/` 子目录用，所有 part 名 fallback 到 `170.dat` filename，任何描述性搜索 0 hit。env 现统一为"库根目录"语义。

---

## 用例 1 — StatusBar plug count（A2-1b）

**目标**：装配体 plug 概览显示对不对。

| 步骤 | 操作 | 预期 StatusBar 右下 |
|---|---|---|
| 1 | 场景空 | (没 plug 显示) |
| 2 | 拖一个 **40490 (Technic Beam 9)** 进场景 | `Plugs: 1 / 1`（紫绿）|
| 3 | 再拖一个 **2780 (Pin)** | `Plugs: 3 / 3` |
| 4 | 再拖一个 **170 (Gearbox)** | `Plugs: 5 / 5` |

**失败信号**：plug 数完全不出现 / 40490 显示 18 而不是 1 / 2780 显示 1 plug 而不是 2。

---

## 用例 2 — Hover halo 看 plug 边界（B.1）

**目标**：hover 一个 port，看同 plug 的兄弟 port 是否一起亮黄色 halo。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 场景里放 **40490 (Beam 9)** | 部件渲染出来 |
| 2 | Hover 顶面任一孔的 port arrow | 同方向 9 孔暖黄半透明 halo（被 hover 那个走常规高亮，不重复 halo）|
| 3 | Hover 底面任一孔 | 底面 9 孔亮，顶面**不亮**（贯通孔合 1 plug 但分方向，仅同方向才联动）|
| 4 | 换 **170 (Gearbox)**：hover 任一 port | 同 plug 的 3-4 个兄弟一起亮（170 有 2 plug × 4 port）|

**真直觉测试**：9 孔贯通合 1 plug 是否符合你的预期？如果你期望"前 5 孔 + 后 4 孔分开"，反馈我调聚类启发式（`backend/plug_clustering.py`）。

**失败信号**：hover 仅高亮被 hover 那一个 / 同一 beam 顶+底所有 18 个一起亮（方向边界没生效）。

---

## 用例 3 — Shift+Click 整片选中（B.2）

**目标**：Shift+Click 切 PLUG mode，全 plug member 一起橙色高亮。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 场景放 **40490 (Beam 9)** | |
| 2 | **普通 click** 任一孔 | 该单个孔的 port arrow 橙色（原 port-level 行为）|
| 3 | Esc 清选 | 高亮消失 |
| 4 | **Shift+Click** 任一顶面孔 | 同方向 9 个孔一起橙色 ✓ |
| 5 | 注意 `selectedPort` 落在哪 | 应是**中央**那颗（重心最近，第 5 个）|

**失败信号**：Shift+Click 只 1 个孔橙色 / 9 个亮但混进底面 9 个（方向过滤失效）/ anchor 落在角上而非中央。

---

## 用例 4 — Pre-commit 预览（B.3-extension）

**目标**：PLUG mode 状态下 hover target plug，StatusBar 显示预计配对数。

| 步骤 | 操作 | 预期 StatusBar |
|---|---|---|
| 1 | 场景放 **两个 40490 (Beam 9)** A 和 B（B 摆 A 旁边，未接触）| |
| 2 | Shift+Click A 任一孔 | 9 个孔橙色（PLUG mode 锁定）|
| 3 | Hover B 反向面孔（A 顶面被 PLUG-locked → hover B 的反向面让极性兼容）| amber 色 **`≤ 9 pairs`** 出现 |
| 4 | Hover B **同向**孔（同性 FEMALE↔FEMALE，不兼容）| **`≤ 9 pairs` 消失**|
| 5 | 单独拿一个 2780 (Pin)，Hover 它的 port | `≤ N pairs` 消失（pin 是单 port plug，N=1 不显示）|

**失败信号**：amber `≤ N pairs` 始终不出现 / 出现但数字明显错（应该 9 显示 1）/ 同性 hover 也亮（兼容性筛失效）。

> 注：40490 的孔是 FEMALE CYL（peghole）— 跟另一根 40490 的孔配对实际需要"穿同一根 pin"，纯几何贴在一起本身是 FEMALE↔FEMALE 不兼容。**真要测 plug snap**，看用例 5 用 pin → beam 配对。

---

## 用例 5 — 整片 snap commit + 反馈（B.3-3）

**目标**：commit 完成后 StatusBar 显示实际配对数 + LogPanel 有 [PlugSnap] 日志。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 场景放一根 **40490 (Beam 9)** 和一个 **2780 (Pin)**，pin 摆 beam 旁边 | |
| 2 | Shift+Click pin 的任一端（pin 有 2 plug，每 plug 1 port — 退化到单 port 路径）| 那一端 port arrow 橙色 |
| 3 | 单 port plug 整片 snap 退化成普通 snap — Click beam 任一孔 → 实际 snap | pin 移到 beam 孔上 |
| 4 | 看 StatusBar | `✓ 1 pair`（不显示，因 < 2）|
| 5 | LogPanel | `[AutoLatch] Snap(...)` 或无（单 port 路径不打 [PlugSnap]）|

> Technic 数据集缺多 port plug × 多 port plug 的对扣场景（例如经典 stud-plate 对 tube-plate 8↔8）。要严测整片 snap，得加经典 plate 进 verified set，或者构造一个多孔横梁堆叠场景（A 是 40490，B 也是 40490，pin 阵列穿过）。**当前数据集下用例 5 的"`✓ N pairs` 显示"很难触发**，是数据问题不是代码 bug。

**改用 `[AutoLatch]` 路径验证**：拿两根 40490 横置，几个 pin 穿过对孔 → 后端 Auto-Latch 应该把"pin 的另一端进入对面 beam 的孔"额外闭合。看 LogPanel 是否有 `[AutoLatch] 后端自动闭合 N 条额外连接`。

---

## 反馈应该报什么

1. **plug 聚类直觉对不对** — 9 孔贯通合 1 plug 你觉得对吗？换成 5+4 分开会更直观吗？
2. **重心 anchor 选择** — Shift+Click 9 孔落中央那颗，符合点击意图吗？还是宁愿固定落在你刚点的那颗？
3. **预测 vs 实际差距** — `≤ N pairs` 跟 `✓ N pairs` 经常差多少？经常对不上 → 后端阈值或前端预测漂移
4. **意外行为** — 哪些操作让 halo 没出现 / 选中清不掉 / 预览卡死
5. **数据集补缺** — 想测真"plate 对 plate stud-tube 阵列"，需要把 3020/3022/3023 等经典 plate 加进 verified set（独立 issue）

## 已知的可调旋钮

| 想调什么 | 文件 | 常量 |
|---|---|---|
| plug 聚类边界 | `backend/plug_clustering.py` | `NORMAL_DOT_THRESHOLD` / `MAX_GAP_RATIO` / `DUAL_FACE_PROJECTION_THRESHOLD` |
| Auto-Latch 闭合距离阈值 | `backend/auto_latch_scanner.py` | `AUTO_LATCH_THRESHOLD_M`（默认 1mm）|
| Halo 颜色 / 大小 / 透明度 | `frontend/src/components/SiteGizmo.tsx` | `PLUG_SIBLING_HALO_*` |
| 预览上界算法 | `frontend/src/utils/pickPlugAnchor.ts` | `predictPlugSnapUpperBound` |

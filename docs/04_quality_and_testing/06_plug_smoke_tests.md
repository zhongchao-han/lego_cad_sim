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
| 5 | 注意 `selectedPort` 落在哪 | **应是你刚点的那颗**（"原位 anchor"，bug fix 后）|

**失败信号**：Shift+Click 只 1 个孔橙色 / 9 个亮但混进底面 9 个（方向过滤失效）/ anchor 跳到中央而非你点的位置。

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

## 反馈收集 — A 段 1-3 天用法

### 反馈 1：plug 聚类直觉

**怎么观察**：
1. 场景放 **40490**，clear localStorage 重新加进，**不要**点任何东西
2. 单纯用鼠标在 beam 上不同孔位 hover（前提：先 click 任一孔进 SOURCE_LOCKED，或开 debug 模式 "Show All Ports"）
3. 慢慢移动 cursor 经过 9 个孔的位置，观察哪些 port 同时亮黄 halo
4. 重复换 **170 (Gearbox)** — 它有 2 plug 各 4 port，hover 一组看是否符合直觉
5. 复杂部件试 **32525 (Technic Beam 22 port / 1 plug)** — 22 个孔全合 1 plug 在你看来过粗吗？

**记录格式**（截图 + 文字均可）：
```
40490: ◯ 9 孔合 1 OK / ◯ 宁愿 5+4 分组 / ◯ 宁愿其他切法 [描述]
170:   ◯ 2 plug 边界对 / ◯ 边界错（应该 N plug）
32525: ◯ 22 孔合 1 OK / ◯ 太粗，宁愿 N 组
```

**调旋钮**：聚类太碎 → 改 `MAX_GAP_RATIO` 调大（从 2.0 调到 3.0）；太合 → 改小。改完 re-run `python scripts/inject_plugs.py` 重灌数据 + reload 浏览器。

---

### 反馈 2：Anchor 选优（已修 ✅）

**历史**：B.2 初版用 "nearest-to-centroid" 启发式 — 用户 Shift+Click 端点期望 source 是该端点，但 anchor 跳到 plug 中心，端点 click 可能位移 32mm（4 个孔位）。

**修后**：改为 "**原位 anchor**" — Shift+Click 落在哪就是哪。Plug 视觉整片高亮（ACTIVE_COLOR）仍按 plug member 集合工作。

**验证方法**（如果有疑虑）：
1. Shift+Click 40490 的左端孔 → 看 sel_pos.z 是否 = -0.032
2. Shift+Click 右端孔 → sel_pos.z 应 = +0.032
3. 中央那颗 → sel_pos.z = 0

期望：3 次都"原位"，没有跳。如果 anchor 又跳了，bug 复发。

---

### 反馈 3：Hover 精度（已修发现性 ✅）

**历史**：B.1 初版要求 SOURCE_LOCKED 才显 port arrows，halo 也跟着只在锁定后才能看到 — 用户得先盲点一个 port 再 hover 探索，发现链太长。

**修后**：hover 部件本体即显该部件 18 个 arrows，halo 立刻可见。从 READY 状态就能 explore plug 边界。代价：场景里 hover 任一部件都显其 arrows，可能视觉杂讯（但比 plug 看不见的成本低）。

**仍可能痛**的子问题：
1. 单个 **port arrow hit zone** 还是小（7 LDU，屏幕几像素）— hover 到 port 球壳触发 sibling halo 时容易 miss
2. **底面 plug member halo** 被 beam mesh 从默认 camera 角度遮挡（即使 `depthTest:false` 也救不了正面 camera 角度只看 1 面）

**仍想测**：
1. 场景放 40490，hover beam 看 18 arrows 全出 → 应该立显 ✓
2. 在 arrows 中间慢慢移动，找一颗 port，看 halo 是否在其他 17 颗上出现
3. 旋转 camera 看底面 → 底面 9 sibling 是否也都黄

**记录格式**：
```
hover 即显 18 arrows: __ Yes / __ No (复发)
sibling halo 命中率: __/10
底面 halo 可见: __ Yes / __ No
```

**残留可调**（如果还痛）：
- 加大 port hit zone (`GIZMO_SPHERE_R_ENLARGED` 7→10 LDU)
- halo 半径 13→18 LDU 让底面也露出
- "部件级 hover + nearest-port 推断"（自动选最近 plug，cursor 不需精确）

---

### 反馈 4：数据集瓶颈

**怎么观察**：
1. 用 Cmd+K 搜索 + Library 浏览，**试着搭一个你平时玩 LEGO Technic 会做的东西**（不需要完成，搭一半就行）
2. 记录卡点：
   - 找不到的关键部件：搜索 0 hit 或浏览找不到（部件 #__？）
   - Technic 系列不够覆盖你的玩法：需要哪类经典部件（plate / brick / slope）？
3. 试**两根 40490 平行 + 几个 2780 pin 穿过对孔**这种 plug snap 大场景能不能搭起来
   - pin 进 beam 孔 → snap 自动对齐 → 后端 Auto-Latch 是否帮把 pin 另一端进对面 beam 也自动闭合？看 LogPanel `[AutoLatch] 后端自动闭合 N 条额外连接` 是否出现

**记录格式**：
```
日常 Technic 玩法 cover 率：
  - 完全够 ◯
  - 缺少 [列举部件类型]
  - 强烈需要 [具体 part 号]

plug snap 大场景测试：
  - pin 穿对孔 Auto-Latch 命中：◯ Yes / ◯ No (看不到 [AutoLatch] log)
  - 实际配对数 vs 我期望差距：__ pair
```

**调旋钮**：
- 缺部件 → 把 LDraw `.dat` 加进 `data/ldraw_port_configs.json` 跑 verified set（独立 issue）
- Auto-Latch 漏 → 改 `backend/auto_latch_scanner.py::AUTO_LATCH_THRESHOLD_M` 从 1mm 调大到 2-3mm（容差换召回率）

---

## 反馈汇总模板

最简单的回报格式 — 直接复制填空：

```
=== A 段反馈 (用了 N 天) ===

[1] 聚类
  40490 9孔合1: __ (OK/分5+4/其他)
  170  2plug:  __ (OK/错)
  32525 22孔合1: __ (OK/太粗)

[2] Anchor
  已修为原位 anchor (✅ B.2 follow-up); 如复发，描述: ___

[3] Hover 精度
  40490: __/10
  170:   __/10
  主观: ___

[4] 数据集
  Cover 率: __ (完全/缺类型/缺具体)
  缺的部件: ___
  Auto-Latch 命中: __

下一步推荐: ___ (调聚类 / 调 anchor / 做 hover 改进 / 补部件 / 都先不动)
```

## 已知的可调旋钮

| 想调什么 | 文件 | 常量 |
|---|---|---|
| plug 聚类边界 | `backend/plug_clustering.py` | `NORMAL_DOT_THRESHOLD` / `MAX_GAP_RATIO` / `DUAL_FACE_PROJECTION_THRESHOLD` |
| Auto-Latch 闭合距离阈值 | `backend/auto_latch_scanner.py` | `AUTO_LATCH_THRESHOLD_M`（默认 1mm）|
| Halo 颜色 / 大小 / 透明度 | `frontend/src/components/SiteGizmo.tsx` | `PLUG_SIBLING_HALO_*` |
| 预览上界算法 | `frontend/src/utils/pickPlugAnchor.ts` | `predictPlugSnapUpperBound` |

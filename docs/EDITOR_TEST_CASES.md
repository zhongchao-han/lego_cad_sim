# LDraw Web CAD 三维编辑器测试用例 (Test Cases)

## 用例集 TS-5：全息粘贴跟踪系统 (Free Placing Paste)

| 用例 ID | 测试目标 | 前置条件 | 操作步骤 | 预期结果 (Assertion) |
| --- | --- | --- | --- | --- |
| TS-5.1 | Payload 挂载 | 预选中一块处于 `[10,0,10]` 的主件 | 按下手柄快捷键 Cmd+C ，然后 Cmd+V | 系统并非落盘进 parts；而是将 `interactionPhase` 切往 `FREE_PLACING`，且 payload 内部的坐标映射被减去其中心，以局部 `0,0,0` 中立标系封存数组中等待鼠标接盘。 |
| TS-5.2 | 取消放置 | 当前处于跟随吸附状态 | 此时用户深究不悦，敲下了 `ESC` 或按下鼠标右键 | payload 被空切剔除；重归于 IDLE，没有任何废料驻存在引擎场站和 history 历史里。 |
| TS-5.3 | 实锤确认放置 | 处于跟随状态 | 模拟发来 commitFreePlacing( {最终确信的位置} ) | 新实例正式写入 `parts` 栈中，selection 大权交接转移至新出场的角色上以方便他继续微操（并且生成了一条带 Undo 的 PASTE 历史）。 |

## 用例集 TS-6：焦点运算与改键增幅 (Advanced Mouse & Keyboard Tricks)

| 用例 ID | 测试目标 | 前置条件 | 操作步骤 | 预期结果 (Assertion) |
| --- | --- | --- | --- | --- |
| TS-6.1 | Camera Auto Focus 平均包围核弹 | store 选中了两块相距 20 个身位的左右护甲 | 使用 F 快捷键驱动 `focusCameraOnSelected()` | `cameraTarget` 数据流被更新为双方距离的正中心 (10方位)，不偏不倚照亮居中空间。 |
| TS-6.2 | Multi-Select 开拓防漏模式 | store 原本选中了 A。 | 当下带着 `append=true` 的意志调用 selectPart传入 B | allConnectedIds 里囊括了 A 且加入了 B（集合无重容合并）。而不是发生以往替换式的丢弃行径。 |
| TS-6.3 | 狂暴穿模验证 | 在沿原积木插槽的轴上正用鼠标滑动位移 | 该手势操作携带 `shiftKey=true` 信息 | 系统不将其值送入 `Math.max(clamp)` 进行设点卡喉，直接原始输出 offset 差值使其穿插。 |

## 用例集 TS-7：图章与流水线装配 (Continuous Stamp Assembly)

| 用例 ID | 测试目标 | 前置条件 | 操作步骤 | 预期结果 (Assertion) |
| --- | --- | --- | --- | --- |
| TS-7.1 | 连续图章激活 | 用户从零件库预览面板中选择某个零件的端口 (如 `2780` 科技销) | 系统携带 `isFromPreview: true` 标记触发 `handlePortClick` | Store 状态机将 `continuousPlacementSource` 置为源端口数据，进入 `SOURCE_LOCKED`。 |
| TS-7.2 | 无缝滑动接力 | 第一个 `2780` 已被放入场景的孔中，系统处于 `AXIAL_SLIDING` | 不提交滑动，直接移动鼠标悬停在旁边另一个合法的孔位上 | 系统成功通过极性过滤（仅基于 `continuousPlacementSource` 的类型筛选），向用户展现 `PlacementGhost` 幽灵预览，表示下一个销即将落位。 |
| TS-7.3 | 连点静默提交 | 与 7.2 相同，处于悬停预览状态 | 单击鼠标左键 | 上一个滑动自动被 `commitAxialSliding` 静默提交写入 `parts`，同时产生一个新的 `InstanceID` 被挂载在当前点击处并直接吸附，系统无缝重入新的 `AXIAL_SLIDING`。 |

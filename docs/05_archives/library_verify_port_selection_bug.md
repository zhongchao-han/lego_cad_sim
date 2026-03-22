# Issue 分析：Library Verify 端口重合交互失效及交互稳定性修复

> **To Claude Code CLI:**
> Please read the following files immediately to establish a stable context prefix:
> - `frontend/src/VerificationWorkbench.tsx` (Workbench Logic)
> - `frontend/src/PortVisualizer.tsx` (Gizmo Interaction)
> - `verificationStore.ts` (State Management)

<current_pain_points>
1. **重合端口无法选中**：在原点 [0,0,0] 处有多个端口重合时（例如解析 LDraw 生成了重复项或是手动添加），移走前两个端口后，驻留在原点的最后一个端口由于 Hitbox 过小（仅 5 LDU），且摄像机跟随移动后在视口中变得极小，导致极难选中。
2. **射线检测干扰（Raycast Interception）**：原点处的 `axesHelper` (坐标轴) 和 `Grid` (网格) 在没有设置禁用交互的情况下，会占据原点的射线检测优先级。用户点击原点端口时，射线先命中辅助线，导致 `PortVisualizer` 的 `onClick` 不触发，转而触发 Canvas 的 `onPointerMissed` 清空选择。
3. **渲染稳定性 (WebGL Context Lost)**：在复杂模型克隆和频繁交互下，会出现 WebGL 上下文丢失，间接导致 Raycaster 失效，产生“无法选中”的假象。
</current_pain_points>

<core_design_rules>
1. **交互热区解除视觉绑定 (Hitbox Independence)**：端口的点击区域必须大于其实际视觉表现（视觉 5 LDU，交互热区设为 15 LDU），尤其是在摄像机可能拉远的情况下。
2. **场景装饰物透明化 (Passive Elements)**：所有非交互的装饰性对象（网格、坐标轴、零件模型主体）必须明确执行 `raycast={() => null}`，禁止参与或阻挡对核心交互点（端口）的射线检测。
3. **事件传播控制 (Event Propagation)**：端口点击必须严格执行 `e.stopPropagation()`，确保一旦选中端口，不会触发背景的“取消选择”逻辑。
</core_design_rules>

<architecture>
- **解法 1：隐式检测球 (Invisible Trigger)**：在 `PortVisualizer` 中引入一个半径为 15 LDU（0.006 单位）的透明 Mesh 专门负责 `onClick`，解决了在高分辨率或远距离视角下的“点不准”问题。
- **解法 2：辅助工具脱离检测流**：在 `VerificationWorkbench.tsx` 中为 `axesHelper` 和 `Grid` 显式声明了 `raycast={() => null}`。
- **解法 3：模型主体防御性检测**：在 `PartModel` 预处理器中，直接将克隆后的 Mesh 的 `raycast` 函数置空，确保只有端口 Gizmo 是唯一的交互点。
</architecture>

<negative_constraints>
- **严禁使用表面原始像素判定选择**：必须依赖 Three.js 经过缩放补偿后的射线检测。
- **不要在 Workbench 顶层捕获点击**：所有的端口选择逻辑应封装在 `PortVisualizer` 内部，通过 Store 修改状态，保持单一职责原则。

---

## [Status: Fixed & Refactored]
- **修复确认**：通过引入 `GenericCameraController` 和扩大 `PortVisualizer` 交互热区（Hitbox），原点处重合端口的选中成功率提升至 100%。
- **重构成果**：将复核工作台与装配场景的摄像机代码合二为一，遵循 SRP（单一责任原则），实现了跨模块的对焦逻辑复用。
</negative_constraints>

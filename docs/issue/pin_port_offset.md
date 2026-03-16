# Issue 分析：插销连接端口（紫色圆球）位置偏移

> **To Claude Code CLI:**
> Please read the following files into your context immediately to establish a stable context prefix for Prompt Caching:
> 
> Required context files:
> - `server.py` (核心 Bug 所在地)
> - `frontend/src/Scene.jsx` (前端表现与 Fallback 逻辑)
> - `port.py` (端口定义基类)
> - `topology_manager.py` (拓扑管理逻辑)

<directory_structure>
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
├───server.py                # 待修改：后端端口投影逻辑
├───port.py                  # 参考：端口类型定义
├───topology_manager.py      # 参考：连接边管理
└───frontend/src/
    └───Scene.jsx            # 参考：前端 Gizmo 渲染与 Fallback 坐标
</directory_structure>

<current_pain_points>
1. **视觉位置偏差**：在 ASSEMBLY 模式下，插销零件（如 6558.dat）的紫色圆球（Peg Port）未出现在轴心尖端，而是出现在侧边圆柱面上。
2. **吸附逻辑失效**：由于端口坐标被投影到了侧边，导致零件吸附时无法实现中心轴对齐，产生了错误的位姿计算。
3. **数据冲突**：后端返回的错误坐标覆盖了前端原本可能正确的 Fallback 硬编码坐标。
</current_pain_points>

<core_design_rules>
1. **LDraw 规范一致性**：根据 LDraw Connectivity 标准，`peg` 类型端口的默认进入轴（Inward Axis）为 **Z 轴 `[0, 0, 1]`**。
2. **坐标系转换**：后端计算必须考虑到零件的旋转矩阵（`rot`），确保投影轴在局部坐标系中指向正确的“尖端”方向。
3. **投影逻辑目的**：投影的目的是找到零件在连接轴向上的几何最远点，以确定“插入深度”的起点。
</core_design_rules>

<architecture>
- **后端 (server.py)**：负责解析 LDraw 文件并根据几何网格动态调整端口位置。
- **前端 (Scene.jsx)**：根据后端返回的 `ports` 数组渲染 `sphereGeometry`。
- **数据流**：`LDrawParser` -> `get_ldraw_part` (位置修正) -> `JSON API` -> `LegoPart` 渲染。
</architecture>

<analysis_details>
在 `server.py` 的 `get_ldraw_part` 函数中（约 L118 处），投影轴被错误地硬编码为 Y 轴：
```python
inward_axis = rot @ np.array([0.0, 1.0, 0.0]) # 错误：使用了 Y 轴
```
对于大多数 LDraw 插销零件，长轴/连接轴通常是 Z 轴。使用 Y 轴会导致程序寻找零件在半径方向上的最大值，从而将端口推向侧边。
</analysis_details>

<negative_constraints>
1. **不要修改前端 API 的数据结构**：保持 `LDrawPort` 的 `position` 和 `rotation` 格式不变。
2. **不要删除前端的 Fallback 逻辑**：它在后端服务不可用或模型解析失败时仍需作为保底方案。
3. **不要引入额外的第三方几何库**：仅使用现有的 `numpy` 进行向量运算。
</negative_constraints>

# Issue: 插销端口位置与朝向异常分析报告

> **To Claude Code CLI:**
> Please read the following files into your context immediately to understand the data flow and current logic:
> - `ldraw_parser.py` (LDraw semantic extraction)
> - `server.py` (Port projection & API layer)
> - `frontend/src/Scene.jsx` (Rendering & fallback logic)
> - `port.py` (Port normalization classes)

<current_pain_points>
1. **端口朝向视觉偏转**：插销（MALE）类零件的紫色 Gizmo 箭头在场景中朝向 +Z 或 +Y，而非零件物理长轴方向（X 轴）。
2. **后端原件解析漏网 (Parsing Gaps)**：
   - **现象**：执行 `curl http://127.0.0.1:8000/api/ldraw_part/4274` 返回 `ports: []`。
   - **原因**：`ldraw_parser.py` 的 `SEMANTIC_PRIMITIVES` 识别列表太窄，未包含 `connect.dat` (4274, 3673 的核心原件) 和 `stud2a.dat`。
   - **后果**：大量插销零件在后端丢失端口信息，强制前端进入最差路径的 Fallback 逻辑。
3. **后端投影向内塌陷 (Projection Reversal Bug)**：
   - **代码位置**：`server.py` L147-153 `get_ldraw_part` 函数。
   - **逻辑错误**：代码中使用 `tip_dir = -inward_axis`。
   - **分析**：根据 `Port` 类约定，Z 轴 (Column 2) 是插入/突出方向。对于插销，这是指向零件外部的方向。取反（`-`）后，投影算法会寻找零件**内部**最远的顶点，导致端口位置从末端“缩回”到零件几何中心甚至另一侧。
4. **前端 Fallback 逻辑硬编码偏差**：
   - **代码位置**：`Scene.jsx` L200-206 `effectivePorts` 默认路径。
   - **现象**：当后端返回空端口时，前端默认生成 4 个 `peghole` 类型的端口。
   - **错误细节**：默认端口位置为 `[pitch, 8*LDU, 0]`，旋转矩阵为 `[[1, 0, 0], [0, 0, 1], [0, -1, 0]]`。这导致箭头方向固定指向 $+y$。在 4274 这种短插销上，用户会看到 4 个悬空的指向 +y/z 的紫色球体。
5. **6558.dat 旋转矩阵矛盾**：
   - **API 数据**：`6558` 端口 1 的 `rotation` 为 `[[0,0,-1],[0,1,0],[1,0,0]]`。
   - **解析**：其第三列（Z 轴）为 `[-1, 0, 0]`。虽然在数据层指向 -x，但配合错误的投影位置（$x=+0.012$），导致箭头指向零件内部。
</current_pain_points>

<detailed_data_evidence>
### 1. 4274.dat (Technic Pin 1/2) 数据快照
- **LDraw 结构**：引用了 `connect.dat` (L19)。
- **后端 API 输出**：`{"part_id":"4274","ports":[], ...}`
- **前端渲染结果**：由于 ID 无法匹配 `Scene.jsx` L187 的 `pin` 字符串判定，触发 L200 默认 Fallback，生成 4 个位置偏移为 `8*LDU` 的 `peghole` 端口，并指向 +y。

### 2. 6558.dat (Technic Pin Long) 数据快照
- **API 输出内容**：
  ```json
  {
    "type": "peg",
    "position": [0.011999999999967998, 0.0, 0.0],
    "rotation": [[0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]]
  }
  ```
- **矛盾分析**：
  - **位置**：$0.01199$ ($30$ LDU) 是该零件几何的最极端点。由于 `server.py` 中 `tip_dir` 符号取反，该端口本应在 $-x$ 端却被强行投影到了 $+x$ 坐标。
  - **方向**：旋转矩阵 Z 轴为 `[-1, 0, 0]`。在位于 $+x$ 端的位置上，这个“向内”的方向导致箭头穿过了零件身体。
- **浏览器观测**：開啟 Debug mode (Axes) 后，灰色插销长轴与红色 X 轴平行，紫色 Gizmo 箭头垂直指向蓝色 Z 轴。

### 3. 2780.dat (Technic Pin with Friction)
- **LDraw 结构**：引用了 `confric5.dat`。
- **解析行为**：后端识别了 `confric` 前缀并返回了一个端口。但受投影 Bug 影响，该端口位置从零件边缘“缩回”到了内部，且由于 `Port.py` 的归一化逻辑，其 Z 轴在场景中与世界坐标系的 Z 轴重合。
</detailed_data_evidence>

<core_design_rules>
1. **Z轴插入约定**：所有 `Port` 对象的 `rotation` 矩阵第三列（Z轴）必须严格定义为“插入/突出方向”。FEMALE 朝向开口，MALE 朝向突出端。
2. **后乘归一化**：LDraw 原始 Y 轴主向必须在后端解析阶段通过 `Port._normalize_insertion_axis` 统一转化为 Z 轴主向。
3. **坐标系隔离**：后端负责 LDU 到 SI 的转换及几何校准，前端仅负责基于后端提供的位姿进行渲染，不应含有对特定零件 ID 的几何硬编码。
</core_design_rules>

<architecture>
- `ldraw_parser.py`: 负责从 `.dat` 文件递归提取语义原件。
- `server.py`: 调用解析器并在 `/api/ldraw_part/` 接口执行 `peg` 顶端投影校准。
- `frontend/src/Scene.jsx`: 使用 `useLDrawPart` 获取数据并渲染交互 Gizmo。
</architecture>

<negative_constraints>
1. **不要修改代码**：本文件仅用于记录和分析问题原因，禁止在此阶段直接修改源码。
2. **不要变动 LDraw 库**：严禁修改 `ldraw_lib/` 下的原始数据文件。
3. **不要改变 SI 转换系数**：保持 `1 LDU = 0.0004m` 的比例不动。
</negative_constraints>

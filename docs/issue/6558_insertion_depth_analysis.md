# Issue 分析：长短端插销 (6558) 的插入深度与多单元端口识别问题

> **To Claude Code CLI:**
> 请立即将以下文件读入上下文，以建立稳定的提示词缓存 (Prompt Caching) 前缀：
> - `ldraw_parser.py` (核心端口提取逻辑)
> - `port.py` (端口对象与归一化)
> - `server.py` (后端 API)
> - `frontend/src/store.ts` (前端吸附逻辑)

<current_pain_points>
1. **插入深度不足 (Incomplete Insertion)**：点击插销 (如 6558) 的长端端口对齐到梁孔时，长端仅能进入一半（1L 深度），无法完全插入到底。这是因为长端 (2L 长度) 目前只识别出了一个位于其第一个单元中心的端口。
2. **端口分布不均 (Sparse Port Density)**：对于像 6558 或长轴 (Axle) 这种跨越多个网格单元 (Grid Units) 的零件，系统目前无法识别出其沿轴向的所有有效连接位点。
3. **过度依赖单一原件点 (Primitive Center Bias)**：解析逻辑目前是“一个 LDraw 原件对应一个 Port”，忽略了 LDraw 原件本身可能带有缩放 (Scaling) 或长度语义。
</current_pain_points>

<root_cause_analysis>
### 1. LDraw 语义提取逻辑局限
在 `ldraw_parser.py` 中，识别 `peg` 端口的依据是子原件（如 `confric*.dat` 或 `pin.dat`）的出现。
- **现状**：解析器记录子原件的变换矩阵平移分量作为端口位置。
- **问题**：在 `6558.dat` 中，长端 (2L) 可能被定义为一个带有 $2 \times$ 缩放的 `confric` 原件，或者仅仅在起始位置放置了一个原件。解析器只在原件中心产生一个 Port。
- **后果**：对于 2L 长的段，用户只能点到它的中点，导致对齐时剩下 1L 长度留在孔外。

### 2. 几何中心对齐 vs 语义点对齐
目前的 `snapParts` 已经实现了点对点平移，但由于“点”不够多，用户无法选择更深的“点”来对齐，从而限制了插入深度。
</root_cause_analysis>

<core_design_rules>
### 1. 步长采样原则 (Pitch-based Sampling)
为了保持通用性，**严禁**为 `6558` 或任何特定零件编写硬编码的端口偏移量。
- **通用算法**：在解析 `peg` 或 `axle` 类型的原件时，检查其变换矩阵在插入轴（Z 轴）上的缩放分量 $S$。
- **采样逻辑**：如果该段跨度 $L \approx S \times 20$ LDU 且明显超过 1 个标准单元长度：
  - 按照乐高标准步长 **20 LDU (8mm)** 进行沿轴采样。
  - 在该段的每个单元中心生成一个独立的 `Port` 对象。
  - 例如：1 个 2L 长的缩放原件应产生 2 个 Port；1 个 3L 长的轴应产生 3 个 Port。

### 2. 插入方向一致性
所有采样生成的端口必须继承原始原件的归一化旋转矩阵，确保 Z 轴始终指向“向外/插入”方向。

### 3. 语义保留
采样生成的端口应保留原始 `port_type`（如 `peg`），以便前端正确渲染 Gizmo。
</core_design_rules>

<negative_constraints>
1. **不要使用 fallback.json 修复此问题**：必须通过改进 `ldraw_parser.py` 的解析算法实现自动化、通用的修复。
2. **不要通过手动平移零件来解决深度问题**：用户应通过点击不同的端口位置来决定对齐深度。
3. **不要修改 port.py 的归一化逻辑**：目前的 Z 轴向外规范是正确的。
</negative_constraints>

<implementation_details>
### 1. 扩展连接器识别范围
修改 `CONNECTOR_PREFIXES`，包含更多科技件连接子原件前缀：
```python
CONNECTOR_PREFIXES = ["confric", "axlehole", "peghole", "axle", "pin", "halfpin"]
```

### 2. 启发式长度检测
引入 `known_unit_lengths` 字典处理缩放为 1 但实际多单元长的原件（如 `confric6.dat` 为 2L）。对于轴类等大型缩放原件，直接将缩放因子视为 LDU 长度。

### 3. 物理间距采样算法
采样逻辑确保生成的端口在物理空间中保持 **20 LDU (8mm)** 的标准步长，不受局部坐标系缩放影响。采样点相对于原件几何中心对称分布，确保了对齐的准确性。
```python
# 物理总跨度 (LDU)
total_ldu = num_units * 20.0
# 局部起始偏移 (LDU)
start_phys_offset = -(num_units - 1) * 10.0
# 物理步长转换为局部坐标
local_offset_y = phys_offset_y / (y_scale * base_unit_len)
```

### 4. 自动化验证
通过 `tests/test_6558_sampling.py` 验证：
- **6558.dat**: 成功生成 3 个去重后的端口（支持深浅两种对齐方式）。
- **3706.dat (6L Axle)**: 成功生成 6 个沿轴向分布的采样点，间距为 8mm。
</implementation_details>

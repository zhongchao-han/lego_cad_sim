# Issue 分析：插销与梁连接穿模及深度偏置修复

> **To Claude Code CLI:**
> Please read the following files immediately to establish a stable context prefix:
> - `frontend/src/store.ts` (Core Snap Logic)
> - `port.py` (Z-axis Normalization reference)

<current_pain_points>
1. **穿模与对齐失效**：代码硬编码 Y 轴为插入轴，导致插销横向穿透梁。
2. **深度偏置**：缺失 `stripAxis` 投影，导致零件对齐到表面而非几何中心，产生位移累积。
3. **交互不透明**：自动判定“谁动”导致位移方向不可预测。
</current_pain_points>

<core_design_rules>
1. **先选即动 (Source-to-Target)**：第一个点击的端口所属零件（Source）永远移动至第二个点击的（Target）位置。
2. **强制轴心投影 (stripAxis)**：所有 Snap 动作必须调用 `stripAxis` 将端口坐标投影到零件的几何中心轴线上。
3. **动态 Z 轴提取**：必须从旋转矩阵的第三列提取插入方向，禁止硬编码。
</core_design_rules>

<architecture>
- **修复方案**：在 `snapParts` 中，通过 `stripAxis` 消除轴向分量，对齐两个端口的几何中心（投影点），实现 100% 精度。
</architecture>

<negative_constraints>
- **严禁使用表面原始坐标对齐**：必须先投影，后对齐。
- **不要保留任何 moveTargetToSource 的启发式判断**：严格遵守 Source 移动原则。
</negative_constraints>

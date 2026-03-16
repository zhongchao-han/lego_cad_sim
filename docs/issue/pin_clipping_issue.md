# Issue 分析：插销与梁连接穿模 (Pin Clipping Issue)

> **To Claude Code CLI:**
> Please read the following files into your context immediately to establish a stable context prefix for Prompt Caching:
> 
> Required context files:
> - `frontend/src/store.ts` (核心 Bug 所在地：snapParts 逻辑)
> - `frontend/src/Scene.jsx` (前端端口数据传递)
> - `server.py` (后端端口坐标生成逻辑)

<directory_structure>
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
├───frontend/src/
│   └───store.ts             # 待修改：吸附对齐算法（snapParts）
└───server.py                # 参考：后端对端口 Z 轴的定义
</directory_structure>

<current_pain_points>
1. **严重的几何穿模**：在执行吸附（Snap）操作时，插销（Pin）会横向穿透梁（Beam）的侧壁，而不是垂直插入孔中。
2. **错误的对齐轴向**：插销的侧面被错误地贴在了梁孔的表面，导致零件旋转角度完全偏离物理真实情况。
3. **坐标约束缺失**：由于对齐轴选取错误，平移补偿逻辑无法在正确的维度上约束零件，导致零件在深度方向上“透传”。
</current_pain_points>

<core_design_rules>
1. **动态轴向推导**：不应硬编码连接轴。必须从端口的 `rotation` 矩阵中提取第三列（Z 轴 / Column 2）作为标准的 **插入轴 (Insertion Axis)**。
2. **三维旋转对齐**：使用 `quatFromUnitVectors` 时，应确保源端口的插入轴与目标端口的插入轴（取反）完全重合。
3. **中心对齐（Centering）**：在计算平移量时，应先在投影平面上对齐端口中心，再处理插入深度的偏移。
</core_design_rules>

<architecture>
- **状态管理 (store.ts)**：`snapParts` 函数负责计算两个零件之间的相对变换矩阵（位姿）。
- **几何变换逻辑**：
    - 第一步：旋转对齐（Rotation Match）。
    - 第二步：平移对齐（Translation Match，基于 `stripAxis` 消除轴向偏置）。
- **坐标系**：使用的是局部空间（Local Space）坐标转换到全局空间（World Space）进行最终计算。
</architecture>

<analysis_details>
在 `frontend/src/store.ts` 的 `snapParts` 实现中（约 L195 处），存在以下致命错误：
```typescript
// 错误 1：硬编码了 Y 轴作为连接轴
const baseAxis: Vec3 = [0, 1, 0]; 

// 错误 2：直接使用该硬编码轴提取局部轴向
const srcAxisLocal = mat3MulVec3(source.rotation, baseAxis); 
```
由于 LDraw 规范中端口的“进入方向”定义在 Z 轴，而代码强制使用 Y 轴，导致系统误以为插销的“侧边”是它的“头”，从而引发了横向穿模。
</analysis_details>

<negative_constraints>
1. **不要修改 `getConnectedGroup` 逻辑**：该部分负责处理零件组的联动位移，逻辑是正确的。
2. **不要硬编码 Z 轴 `[0,0,1]`**：虽然目前大部分是 Z 轴，但应通过矩阵乘法 `rotation * [0,0,1]` 动态计算，以适应复杂的端口旋转。
3. **不要破坏 `isPegIntoHole` 的判断分支**：该分支处理了“移动插销”与“移动梁”的不同策略。
</negative_constraints>

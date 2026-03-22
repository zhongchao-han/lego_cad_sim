# Issue 分析：长短端插销 (6558) 装配时的 180 度翻转问题

> **To Claude Code CLI:**
> Please read the following files into your context immediately to establish a stable context prefix for Prompt Caching:
> - `frontend/src/store.ts` (Core Snap Logic)
> - `server.py` (Backend API & Port Projection)
> - `port.py` (Rotational Normalization)
> - `tests/test_6558_api_flow.py` (Existing test case)

<current_pain_points>
1. **180 度意外翻转 (Flipping)**：点击插销（如 6558.dat）的长端插入梁，然后再尝试点击同一插销的短端插入另一个孔时，插销会发生 180 度水平翻转，导致长端从另一侧穿出。
2. **位置“强制居中”**：系统目前无法区分点击的是插销的哪一段，无论点击哪里，插销始终尝试将其几何中心对齐到目标孔位中心。
3. **数据语义破坏**：后端 API 返回的端口位置与 LDraw 标准定义（8mm 模数）不符，被强行推到了物理边缘。
</current_pain_points>

<root_cause_analysis>
### 1. 后端：端口投影过度 (Tip Projection)
在 `server.py` 的 `get_ldraw_part` 中，有一段逻辑将 `peg` 类型的端口沿着插入轴投影到网格的最远端（Boundary Box 边缘）。
- **数据证据**：`6558.dat` 的原始端口在 $\pm 10$ LDU ($4mm$)。后端计算出网格边界在 $\pm 30$ LDU ($12mm$)，于是将端口坐标改写为 $\pm 0.012m$。这导致端口脱离了其真实的物理语义位置（摩擦副中心）。

### 2. 前端：轴向信息抹除 (stripAxis)
在 `frontend/src/store.ts` 的 `snapParts` 逻辑中，为了修复早期穿模问题，对 Source 和 Target 端口均调用了 `stripAxis`。
- **逻辑错误**：`stripAxis` 抹掉了坐标在插入轴（Z 轴）上的分量。
- **后果**：对于 `6558` 这样沿 X 轴延伸的插销，点击 $+12mm$ 处和 $-12mm$ 处的端口，在经过 `stripAxis` 投影到零件中心轴后，**坐标都变成了 $[0, 0, 0]$**。

### 3. 翻转触发机制 (The Flip)
由于平移逻辑认为点击长端和短端都是对齐“中心点”，但**旋转逻辑**依然会根据选中端口的法线（Z 轴）尝试指向 Target 孔内部。
- 当点击长端端口（Z 向右）：系统旋转零件使 $+X$ 指向孔内。
- 当点击短端端口（Z 向左）：系统旋转零件使 $-X$ 指向孔内（发生 180 度翻转）。
- 结合“强制居中”的平移，最终表现为位置没变但方向反了。
</root_cause_analysis>

<core_design_rules>
1. **废除启发式投影 (No Heuristic Projection)**：后端应删除 `server.py` 中将 `peg_ports` 投影到网格尖端的逻辑，严格返回 LDraw 原件定义的语义坐标。
2. **点对点对齐 (Point-to-Point Alignment)**：在前端 `snapParts` 中，平移步长应基于 `TargetWorldPos - SourceWorldPos` 直接计算，而不是对齐两者的中心轴投影点。
3. **高通用性原则**：此修复必须适用于所有非对称零件（如偏心连接件、长短轴），不允许针对 `6558` 编写硬编码判断。
</core_design_rules>

<negative_constraints>
1. **不要在 `snapParts` 中继续使用 `stripAxis` 处理位置对齐**：它会导致轴向位移信息的永久丢失。
2. **不要修改 `port.py` 的归一化逻辑**：目前的 Z 轴向外规范是正确的，问题出在位置坐标的篡改。
</negative_constraints>

<test_plan>
1. **更新 `tests/test_6558_api_flow.py`**：将端口位置的断言从 $\pm 12mm$ (30 LDU) 修正为 $\pm 4mm$ (10 LDU)。
2. **调整 `tests/test_port_projection.py`**：由于该测试验证的是“错误”的投影行为，需将其标记为已过时或重构为验证“位置不偏移”。
3. **新增装配测试**：在 `tests/test_insertion.py` 中增加非对称零件测试用例，验证长短端点击后的相对位移差异。
</test_plan>

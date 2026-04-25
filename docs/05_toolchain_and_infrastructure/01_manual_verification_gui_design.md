# 技术设计文档：端口数据人工复核系统 (Manual Port Verification)

> **To Claude Code CLI:**
> 请立即阅读以下文件以建立稳定的上下文：
> - `port.py` (Z轴归一化标准)
> - `port_discovery.py` (自动化识别脚本)
> - `docs/technical/port_class_design.md` (端口语义定义)

<current_pain_points>
1. **自动识别局限性**：`port_discovery.py` 虽能提取数学位姿，但无法识别 LDraw 原件建模时的语义随机性（如孔的内向/外向、轴的相位）。
2. **复核门槛过高**：目前的修正需要直接编辑 JSON 中的 3x3 旋转矩阵，对非技术人员极不友好。
3. **缺乏物理反馈**：修正后的端口是否真的能对齐，仅靠数值观察无法判断，必须在 3D 环境中验证。
</current_pain_points>

<core_design_rules>
### 1. 物理语义视觉化 (Visual Semantics)
复核界面严禁展示原始矩阵，必须将其转化为物理暗示：
- **极性色标 (Polar Color Coding)**：系统强制遵循单色源 (SSOT) 规范：
    - **蓝色箭头**：代表 `FEMALE`（孔），Z 轴必须指向开口向外。
    - **紫色箭头**：代表 `MALE`（销/轴），Z 轴必须指向突出向外。
    - **注意**：禁止在任何场景使用蓝色作为单纯的交互状态色。**橙色 (#ff9800)** 仅用于显式锁定状态（Source Locked 激活态），代表已被明确选定为组装原点的端口。目标端口（Target）在寻找时不应有悬停变色。
- **虚影测试 (Ghost Snapping)**：选中端口时，自动生成一个“标准 1L 插销”或“标准梁孔”的半透明虚影进行对扣，直观暴露翻转错误。
- **模数点云 (LDU Grid Overlay)**：在零件周围开启 20 LDU (8mm) 的 3D 网格点，验证端口是否处于合法的乐高格点上。

### 2. 低门槛修正工具箱 (Correction Toolbox)
通过快捷操作代替数值输入：
- **[翻转 180°]**：一键解决 Z 轴“内外反转”问题。
- **[步进旋转 90°]**：解决十字轴相位偏差。
- **[重心对齐]**：自动将端口球体平移至当前孔位的局部几何中心。
- **[对称同步]**：将当前端口的修正结果自动应用到零件的镜像位置或同类原件上。

### 3. 验证即正义 (Validation First)
- **碰撞预览**：当复核人员进行测试吸附时，若发生穿模，受影响的 Mesh 以**红色脉冲**显示。
- **吸附评分**：根据端口与 8mm 网格的偏离度、与标准件的匹配度自动评分，低于 90 分强制标记为“需要人工复核”。
</core_design_rules>

<interaction_flow>
### 交互流程：漏斗式复核法
1.  **自动预检 (Auto-Scan)**：后端扫描所有零件，按“自信度”排序。
2.  **视觉巡检 (Visual Audit)**：复核人员只需检查：
    - 箭头是否全部“向外”？
    - 球体是否全部“在中心”？
3.  **交互修正 (Point & Fix)**：点击异常箭头，使用 Toolbox 快速翻转或对齐。
4.  **动态测试 (Verify)**：放置标准件进行“插拔实验”。
5.  **锁定提交 (Hard Commit)**：在 JSON 中标记 `status: "verified"`，防止被未来的自动化更新覆盖。
</interaction_flow>

<negative_constraints>
- **禁止在 UI 中提供旋转矩阵的文本输入框**。
- **禁止在复核期间修改 LDraw 原始 .dat 文件**，所有修正必须保存在 `ldraw_port_configs.json`。
- **禁止支持非 90° 步进的任意角度旋转**（除非是特殊斜角零件）。
</negative_constraints>

<completion_criteria>
- 复核人员能在 10 秒内判断并修正一个翻转错误的端口。
- 修正后的数据通过 API 返回后，前端渲染的箭头方向必须符合 `port.py` 的 Z 轴向外规范。
</completion_criteria>

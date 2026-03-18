# 技术实现文档：端口数据人工复核系统 (Manual Port Verification Implementation Spec)

> **To Claude Code CLI / Gemini CLI:**
> 请立即阅读以下文件以建立稳定的上下文：
> - `port.py` (Z 轴归一化标准)
> - `port_discovery.py` (自动化识别脚本)
> - `server.py` (后端 API 宿主)
> - `ldraw_port_configs.json` (持久化配置)

<current_pain_points>
1. **识别语义随机性**：自动化脚本无法识别孔的内外方向和轴的相位。
2. **数据易失性**：重新运行自动识别脚本会覆盖人工修正的数据。
3. **复核效率低下**：缺乏直观的 3D 修正工具，依赖手动编辑 JSON 矩阵。
</current_pain_points>

<metadata_persistence>
### 1. 数据架构与持久化 (Metadata Layer)
对 `ldraw_port_configs.json` 进行结构化升级，引入“元数据锁”机制：
- **`status`**: 枚举值 `"pending"` (待处理) 或 `"verified"` (人工已复核)。
- **`confidence`**: 0.0-1.0 浮点数，由识别脚本根据格点对齐度和原件合法性计算。
- **`manual_offset`**: 布尔值，标记特定端口是否经过人工微调。

**元数据锁逻辑**：
扫描器在运行时必须遵循“读-改-写”策略。若零件 `status == "verified"`，则扫描器主动放弃该零件的修改权，除非使用 `--force` 参数。
</metadata_persistence>

<backend_apis>
### 2. 后端 API 支撑 (Verification APIs)
在 `server.py` 中新增用于复核流程的专用接口：
- **`GET /api/verify/pending_list`**: 
    - 返回按 `confidence` 升序排列的待复核零件。
    - 格式：`Array<{ part_id, confidence, port_count }>`。
- **`POST /api/verify/save`**:
    - 接收前端提交的修正后端口数据。
    - 强制执行“状态提升”：更新 `status` 为 `"verified"`。
    - 采用 `merge` 操作确保不丢失其他人工备注信息。
</backend_apis>

<frontend_visualization>
### 3. 前端 3D 视觉化实现 (Three.js / React)
利用视觉隐喻代替数值输入。

#### A. 极性色标 (Polar Color Coding)
- **FEMALE (孔)**：渲染为**蓝色箭头**，Z 轴（箭头指向）必须朝向零件外部。
- **MALE (销/轴)**：渲染为**紫色箭头**，Z 轴（箭头指向）必须朝向突出端外部。

#### B. 虚影对扣测试 (Ghost Snapping)
- **原理**：基于 `port.py` 的 `calculate_relative_transform` 算法。
- **效果**：选中端口时，即时加载半透明标准件（1L 插销或 1L 梁孔）进行虚拟装配。
- **验证**：若箭头反向，虚影会穿透进零件内部，产生直观的错误暗示。

#### C. LDU 网格层 (Grid Overlay)
- 在场景中渲染 20 LDU 步长的 3D 线框。
- 实时计算并显示端口到最近格点的距离，提供精度评分。
</frontend_visualization>

<correction_logic>
### 4. 低门槛修正工具箱 (Correction Toolbox)
禁止手动输入旋转矩阵，仅提供基于局部轴的步进操作：
- **Flip 180°**：绕端口 X 轴旋转 180°（翻转内外指向）。
- **Rotate 90°**：绕端口 Z 轴旋转（修正十字轴相位）。
- **Snap to Grid**：将坐标位置吸附到最近的 10 LDU 或 20 LDU 格点。
- **Symmetry Sync**：利用零件的几何对称性，将修正同步至镜像位置的端口。
</correction_logic>

<system_classes_interfaces>
### 5. 类与接口职责划分 (Architecture)

#### 后端 (Python)
- **`PortDiscoverer`**: 扩展 `_calculate_confidence()` 启发式算法。
- **`PortConfigManager`**: 封装 JSON 读写，执行 `status` 校验逻辑。

#### 前端 (TypeScript/React)
- **`VerificationWorkbench`**: 复核模式容器组件，管理待办队列。
- **`PortVisualizer`**: 封装 `ArrowHelper`，将 `Gender` 映射为颜色。
- **`GhostManager`**: 管理测试虚影的生命周期与对齐计算。
- **`CorrectionController`**: 封装矩阵旋转与格点吸附的数学运算。
</system_classes_interfaces>

<negative_constraints>
- **禁止修改 LDraw 原始 .dat 文件**：所有变更仅限 `ldraw_port_configs.json`。
- **禁止暴力位移**：所有位置修正必须保留在 `ldraw_port_configs.json` 的局部坐标系中。
- **禁止在 UI 中提供原始矩阵输入框**：必须通过图形化按钮进行步进操作。
</negative_constraints>

# 空间与物料管理设计文档：三区流转与状态机规范

> **To Claude Code CLI:**
> Please read the following files into your context immediately to establish a stable context prefix for Prompt Caching:
> 
> Required context files:
> - `frontend/src/store.ts` (前端状态机扩展点)
> - `assembly.py` (后端 Assembly 装配体扩展点)
> - `server.py` (物料目录 API 扩展点)

<directory_structure>
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
├───server.py                # 待扩展：新增 /api/catalog 物料目录接口
├───assembly.py              # 待扩展：新增 Zone 状态管理，隔离工作台零件
└───frontend/src/
    └───store.ts             # 待扩展：新增 InventoryState, PreviewState, WorkbenchState
</directory_structure>

<current_pain_points>
虽然在产品设计中提出了“活跃主画布”、“暂存工作台”和“物料盒”的“三区逻辑定义”，但目前代码库和底层架构设计中完全缺失了支撑这些概念的数据结构。这导致：
1. **状态归属不明确**：`Part` 和 `Assembly` 缺乏枚举或标识来区分物理计算区和挂起暂存区。
2. **槽位管理机制空白**：工作台的 $N \times M$ 槽位分配、自动滑入逻辑缺少具体的网格管理器（Grid Manager）。
3. **物料盒缺乏模板抽象**：从 LDraw 库加载到 UI 展示之间，缺乏 `Template` 到 `Instance` 的转化抽象层，导致预览与实例化逻辑混淆。
</current_pain_points>

<core_design_rules>
### 1. 区域状态枚举 (ZoneType)
零件实例在其生命周期中必须明确属于以下三个空间状态之一：
- **`PREVIEW`**：悬浮预览层（不参与碰撞和渲染树，仅供用户选择初始端口）。
- **`ACTIVE_ARENA`**：主画布（参与物理仿真，由后端完整推导拓扑与刚体运动学）。
- **`WORKBENCH`**：暂存工作台（冻结物理，忽略碰撞，严格按网格排列，不参与 URDF 导出）。

### 2. 物料盒与模板 (Inventory & Template)
- **模板抽象**：在侧边栏物料盒中展示的仅为 `PartTemplate`，包含元数据和局部端口信息。不要在物料盒阶段就创建包含世界坐标的 3D 物理实例。
- **目录服务**：后端需提供 `/api/catalog` 接口，扫描 `ldraw_lib` 并返回可用零件的分类列表与缩略图信息。

### 3. 工作台网格管理 (Workbench Grid Manager)
- 暂存区具有固定的 $N \times M$ 虚拟槽位（Slots）。
- 当主画布发生“双击拆解”且分离出的子装配体 $|S| > 1$ 时，系统必须调用 `findNextAvailableSlot()` 分配物理坐标，并将该子装配体内所有零件的区域状态更新为 `WORKBENCH`。

### 4. 拆解物料回收机制
- 当拆解产生的子装配体是单一零件（$|S| = 1$）时，严禁进入暂存区，必须直接执行“回收”逻辑（销毁实例，清空相关连接）。
</core_design_rules>

<architecture>
## 数据结构与接口定义扩展建议

### 【后端】API 响应与装配体隔离
```python
# server.py / 物料模板定义
from pydantic import BaseModel
from typing import List, Dict
from enum import Enum

class LDrawPortTemplate(BaseModel):
    name: str
    port_type: str

class PartTemplate(BaseModel):
    ldraw_id: str
    name: str
    category: str
    bounding_box: List[float]
    ports: List[LDrawPortTemplate]

# assembly.py / 物理隔离
class PartZone(Enum):
    ACTIVE = 1
    WORKBENCH = 2

class Assembly:
    # 需增加追踪属性
    # self.workbench_roots: set[str] = set() 
    
    def resolve_kinematics(self):
        # 必须过滤掉 zone == PartZone.WORKBENCH 的零件，它们不参与 URDF 导出
        pass
```

### 【前端】Zustand Store 状态机划分
```typescript
// 1. 实例扩展
export enum ZoneType { 
  PREVIEW = 'PREVIEW', 
  ACTIVE_ARENA = 'ACTIVE_ARENA', 
  WORKBENCH = 'WORKBENCH' 
}

interface LegoPartInstance {
  instanceId: string;
  templateId: string;
  zone: ZoneType;
  // ... 其他现有属性
}

// 2. 物料盒状态
interface InventoryState {
  catalog: Record<string, PartTemplate[]>;
  selectedTemplate: PartTemplate | null;
}

// 3. 预览态控制
interface PreviewState {
  previewInstance: LegoPartInstance | null;
  lockedSourcePortId: string | null;
  enterPreview: (template: PartTemplate) => void;
  commitToArena: (targetPortId: string) => void;
}

// 4. 暂存区网格
interface WorkbenchSlot {
  gridX: number;
  gridY: number;
  worldPosition: [number, number, number];
  occupiedBySubAssemblyId: string | null;
}

interface WorkbenchState {
  slots: WorkbenchSlot[];
  findNextAvailableSlot: () => WorkbenchSlot | null;
  moveToWorkbench: (subAssemblyRootId: string) => void;
}
```
</architecture>

<negative_constraints>
- **绝不要混淆 Template 和 Instance**：Template 仅用于 UI 和生成 Instance 的蓝本，没有世界坐标；Instance 才参与场景树。
- **后端物理引擎不可见工作台**：绝对不要将处于 `WORKBENCH` 状态的零件加入运动学图 (`_kinematic_graph`)，也不要为它们创建物理碰撞体。
- **暂存区零件不可发生交互**：在处于 `WORKBENCH` 状态时，用户不能在其上点击发起新的 Snap 操作（必须先拖回主画布）。
</negative_constraints>

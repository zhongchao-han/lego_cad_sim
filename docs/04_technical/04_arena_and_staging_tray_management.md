# 技术设计文档：装配空间管理与数据结构设计

> **To Claude Code CLI:**
> Please read the following files immediately into your context:
> - `frontend/src/staging.ts` (For StagingTray logic and Grid management)
> - `frontend/src/store.ts` (For Zone status transitions)

<directory_structure>
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
└───frontend/src/
    ├───staging.ts           # 核心：暂存区网格算法与区域划分
    └───store.ts             # 状态：Zone 切换与分区存储
</directory_structure>

<current_pain_points>
1. **多区状态混乱**：系统中缺乏对零件所处空间的显式隔离（主画布、暂存区、零件库预览层）。
2. **重力干涉**：暂存区内的零件不应受全局重力或物理系统的影响。
3. **坐标系冲突**：当零件被移入暂存区时，其三维坐标必须从“世界坐标”重映射为“网格坐标”，否则会在空间中乱飞。
</current_pain_points>

<core_design_rules>
### 1. 区域隔离 (Zone Isolation)
定义三种严格隔离的物理/逻辑空间：
- **ACTIVE_ARENA (主画布)**：活跃工作区。参与物理模拟，所有连接关系会反映在导出的 URDF 中。
- **STAGED (暂存区)**：零件暂存托盘 (Staging Tray)。物理引擎对该区零件置为 `Static`。
- **PREVIEW (零件库预览)**：仅用于零件库的浮动预览层，不在此三维空间中保存位姿。

### 2. 网格化布局 (Staging Tray Grid)
所有进入 `STAGED` 区域的零件必须被强制分配到一个 **StagingSlot**。
- 系统根据零件大小自动寻找空闲槽位。
- 采用局部坐标系对齐，确保所有暂存零件整整齐齐地排列在界面的右侧浮动面板中。

### 3. 连接自动切断 (Auto-Severing)
当一个零件从 `ACTIVE_ARENA` 移动到 `STAGED` 区域（如通过双击或右键），系统必须 **自动切断** 该零件与其周围所有零件的 `ConnectionEdge`。
- 移入 `STAGED` 的零件始终是独立的。

### 4. 视图层映射 (UI Layering)
暂存区 (Staging Tray) 在渲染层面通过 2D/3D 混合技术实现。即使是 3D 零件，也应在 UI 面板中展现。
</core_design_rules>

<architecture>
## 数据结构与接口定义建议

### 【前端】1. 区域状态定义
```typescript
export enum ZoneType {
  ACTIVE_ARENA = 'ACTIVE_ARENA',
  STAGED = 'STAGED', // 原 WORKBENCH
}

interface PartState {
  zone: ZoneType;
  position: Vec3;
  quaternion: Quat;
  // ... 其他属性
}
```

### 【前端】2. 暂存区网格管理 (StagingGrid)
```typescript
interface StagingSlot {
  index: number;
  worldPosition: Vec3;
  occupiedBy: string | null;
}

class StagingGrid {
  slots: StagingSlot[];
  assign: (partId: string) => StagingSlot | null;
  release: (partId: string) => void;
}
```
</architecture>

<negative_constraints>
- **严禁跨区连接**：禁止在处于 `ACTIVE_ARENA` 的零件与处于 `STAGED` 的零件之间建立 Snap 连接。
- **术语规范**：系统中禁止出现 `Workbench` 等旧词，一律使用 `Staging`。
</negative_constraints>

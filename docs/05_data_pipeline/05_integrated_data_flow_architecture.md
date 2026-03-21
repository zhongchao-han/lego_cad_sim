# 建筑学设计文档：系统集成数据流 (Integrated Data Flow)

## 1. 宏观数据架构 (High-Level Overview)

本系统采用 **“配置驱动、语义注入、反馈落库”** 的数据闭环架构。数据在三个核心域之间流动：
- **静态资源域 (LDraw Static Repository)**: 那些描述几何形体的原始 .dat 指令。
- **动态服务域 (Backend Runtime & Logic)**: 物理语义解析、坐标归一化、CORS 分发。
- **交互感官域 (Frontend UI & State)**: R3F 渲染、Zustand 状态机、用户操作修正。

### 1.1 数据流向概览 (Mermaid Diagram)

```mermaid
graph TD
    %% 阶段 1: 离线识别
    LIB[LDraw Library /ldraw_lib] -->|Parsing| AP[analyze_ports.py]
    SEM[port_semantics.py] -->|Inject Semantic| AP
    AP -->|Update JSON| JSON[data/ldraw_port_configs.json]
    
    %% 阶段 2: 后台运行时
    JSON -->|Load Mapping| PL[PortLibrary.py]
    PL -->|Create| PO[Port & Site Objects]
    PO -->|REST API| SV[server.py]
    
    %% 阶段 3: 前端消费
    SV -->|JSON Transport| ST[useStore.ts]
    ST -->|Mount| IP[InteractivePart.tsx]
    IP -->|Pointer Interaction| SN[SnapMath.ts]
    
    %% 阶段 4: 反馈闭环
    SN -->|Collision Interference| UP[Verification UI]
    UP -->|User Correction| V_API[/api/verify_part]
    V_API -->|Update Record| PM[PortLibraryManager.py]
    PM -->|Final Commit| JSON
```

## 2. 数据生命周期详解 (Lifecycle Details)

### Phase 1: 知识摄取与语义固化 (Knowledge Ingestion)
- **触发**: 开发者运行 `scripts/analyze_ports.py`。
- **映射逻辑**: 脚本扫描 `ldraw_lib` 零件的子原件（sub-files）。通过查找 `port_semantics.py` 中的 **语义注册表 (INTERFACE_REGISTRY)**，将无意义的几何圆柱识别为具有 `radius`, `gender` 的物理端口。
- **纠偏记录**: **[v1.2 Fix]** 摩擦销 (Friction Pin) 的识别优先级已由于 `6558.dat` 的解析失败被提升。现在的解析器会优先识别 `fric` 关键字并注入 `6.2 LDU` 的摩擦半径。

### Phase 2: 配置驱动的统一加载 (Config-Driven Loading)
- **唯一真理来源 (SSOT)**: `data/ldraw_port_configs.json` 是系统的心脏。
- **运行时性能**: `PortLibrary.py` 不再做繁重的 LDraw 深度递归，而是通过读取 JSON 实现 O(1) 级别的端口数据装载。
- **Site 空间聚合**: 在 Backend 加载时，利用 `Site.cluster_ports` 算法将临近的 Port 坍缩为同一个交互场站 (Site)，解决 CAD 精度带来的抖动问题。

### Phase 3: 前端交互与状态回流 (Sync & Snap)
- **获取数据**: 前端请求 `/api/ldraw_part`。后端返回带有 `ports` 列表和 `meshUrl` 的统一 JSON。
- **视觉映射**: `InteractivePart` 接收坐标，动态生成可交互的 `PortGizmo`。
- **物理验证**: 当用户执行吸附动作时，前端 `SnapMath` 会通过物理参数（半径、极性）预判是否可行。只有合法的连接才会发送至服务器。

### Phase 4: 开发/用户反馈闭环 (The Verification Loop)
- **纠错机制**: 若自动识别的端口偏移了 0.1mm（导致无法插拔），用户可在 **VerificationWorkbench** 中手动微调坐标。
- **落库持久化**: 修改通过 `/api/verify_part` 接口回送至后端。`PortLibraryManager` 负责在 `data/ldraw_port_configs.json` 中更新对应的 `verified` 标记，确保下次启动时错误已永久消失。

## 3. 关键数据结构契约 (Data Contracts)

### 3.1 端口序列化格式 (Port Storage)
```json
{
  "6558.dat": {
    "ports": [
      {
        "type": "fric_pin.dat",
        "position": [0, 20, 0],
        "rotation": [[1,0,0],[0,1,0],[0,0,1]]
      }
    ],
    "status": "pending",
    "confidence": 0.9
  }
}
```

## 4. 架构一致性保障 (Consistency)
- **命名空间**: 全局统一使用 LDraw 原始 ID 作为主键。
- **坐标系标准**: 前端采用 SI (meters)，后端在存储时基于 LDU 归一化，由 `LDU_TO_SI` 常量负责两端的弹性映射。

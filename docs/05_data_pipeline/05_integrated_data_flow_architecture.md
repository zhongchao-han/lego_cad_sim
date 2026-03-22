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
    AP -->|Update JSON SI| JSON[data/ldraw_port_configs.json]
    
    %% 阶段 2: 后台运行时
    JSON -->|Load SI Data| PL[PortLibrary.py]
    PL -->|Create| PO[Port & Site Objects]
    PO -->|REST API| SV[server.py]
    
    %% 阶段 3: 前端消费
    SV -->|JSON Transport| ST[useStore.ts]
    ST -->|Grid Snap LDU| SN[Workbench UI]
    ST -->|Inverse Projection| IP[InteractivePart.tsx]
    
    %% 阶段 4: 反馈闭环
    SN -->|Save to SI| V_API[/api/verify/save]
    V_API -->|Update Record| PM[PortLibraryManager.py]
    PM -->|Final Commit| JSON
```

## 2. 数据生命周期详解 (Lifecycle Details)

### Phase 1: 知识摄取与语义固化 (Knowledge Ingestion)
- **触发**: 开发者运行 `scripts/analyze_ports.py`。
- **递归发现**: 解析器支持对 LDraw 子原件的深层扫描，通过 `port_semantics.py` 的注册表识别物理圆柱并自动转换为 **SI (Meters)** 坐标。
- **正交净化**: 所有录入的旋转矩阵经由 Gram-Schmidt 算法处理，确立完美的正交几何属性。

### Phase 2: 配置驱动的统一加载 (Config-Driven Loading)
- **唯一真理来源 (SSOT)**: `data/ldraw_port_configs.json`。
- **单位契约**: 数据文件内强制使用 **SI Meters (米)**。

### Phase 3: 前端交互与视觉映射 (UI & Rendering)
- **视觉映射**: 由于渲染模型基于 LDU (1:1)，`InteractivePart` 在接收到米制坐标后执行 `pos / 0.0004` (即 2500x) 的空间投影。
- **物理验证**: 吸附计算在前端 LDU 空间完成，以兼容 20-LDU 乐高标准格点，但在回送后端前重新米制化。

### Phase 4: 复核与持久化 (Verification Loop)
- **纠错机制**: 用户在 **VerificationWorkbench** 中手动调整位置，保存时接口将 LDU 指令封装为 SI 指令并持久化。

## 3. 关键数据结构契约 (Data Contracts)

### 3.1 端口序列化格式 (Port Storage Snapshot)
**[重要变更]** 自 v1.3 起，库文件强制采用 **SI (Meters)** 单位存储 `position` 坐标。

```json
{
  "32316.dat": {
    "ports": [
      {
        "type": "beamhole.dat",
        "position": [0.008, 0, 0],  // 单位: 米 (Meters)。0.008m = 20 LDU
        "rotation": [[1,0,0],[0,0,-1],[0,1,0]]
      }
    ],
    "status": "verified",
    "confidence": 1.0
  }
}
```

## 4. 架构一致性保障 (Consistency)

### 4.1 坐标系标准
- **数据库/后端**: 采用 **SI (Meters)**。
- **前端视觉渲染**: 采用 **LDU** (经投影映射)。
- **转换常数**: 1 LDU = 0.0004 Meters。

### 4.2 命名空间
- 全局统一使用 LDraw 原始相对路径/文件名作为主键。

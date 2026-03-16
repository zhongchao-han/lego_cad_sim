# 装配体层级 (Assembly Hierarchy) 的高内聚重构指南

> **To Claude Code CLI:**
> Please read the following files into your context immediately. These files represent the core static knowledge and the existing codebase to be refactored. Reading them together now will help establish a stable context prefix for Prompt Caching, saving tokens in subsequent turns.
> 
> Required context files:
> - `docs/pin_hole_connection_design.md`
> - `docs/port_class_design.md`
> - `connection_interface.py`
> - `topology_manager.py`
> - `server.py`
> - `ldraw_parser.py`
> - `port.py`

<directory_structure>
D:\Users\hanerlv\Documents\workspace\lego_cad_sim\
├── part.py (待新建)
├── assembly.py (待新建)
├── connection_edge.py (待新建/剥离)
├── urdf_exporter.py (待新建/剥离)
├── connection_interface.py (待重构)
├── topology_manager.py (待大幅拆分/废弃)
├── server.py (待重构状态层)
├── ldraw_parser.py (待重构数据出口)
└── tests/
    └── test_insertion.py (待新建)
</directory_structure>

<architecture_overview>
本系统的目标是从一种平铺式的图论节点结构，重构为现代 CAD 系统标准的**树状组合模式（Composite Pattern）**。
核心抽象层级必须是：`ConnectionInterface` -> `Port` -> `Part` -> `ConnectionEdge (伴随 JointState)` -> `Assembly`。
</architecture_overview>

---

## 1. 核心问题：现有架构的职责散乱

<current_pain_points>
在现有的系统中，主要由 `PartNode`（仅作为数据容器）和 `TopologyManager`（承载过多职责的大杂烩）构成。系统倾向于将所有的零件摊平放入一个全局的图 (Graph) 里。
这在处理简单的两两连接时没有问题，但在应对复杂子模块（如：一个独立组装好的悬挂系统装入底盘）以及编写单元测试时，会显得极不内聚。

当前的 `TopologyManager` 既要维护图结构，又要跑 BFS 算法，还要导出 URDF。它扮演了过度膨胀的“上帝类”角色。
</current_pain_points>

---

## 2. 概念重构与定义

<core_design_rules>

### 2.1 明确 `Part`（零件）的边界与职责

让 `Part` 成为内聚管理自身 `Port` 的容器。它不知道外界的存在，只对自身的几何变换负责。

```python
# 概念设计：part.py
from typing import Dict
from port import Port
import numpy as np

class Part:
    """代表一个独立的乐高零件实体（例如：一根 3孔梁）"""
    def __init__(self, part_id: str, name: str, mass: float = 0.001):
        self.part_id = part_id
        self.name = name
        self.mass = mass
        # 零件在全局/父级坐标系下的绝对位姿
        self.transform: np.ndarray = np.eye(4) 
        
        # 核心内聚：Part 拥有并管理自己的 Ports
        self.ports: Dict[str, Port] = {}
        
    def add_port(self, port: Port):
        self.ports[port.name] = port

    def get_port(self, port_name: str) -> Port:
        return self.ports.get(port_name)

    def get_port_global_transform(self, port_name: str) -> np.ndarray:
        """内聚的几何计算：单独测试极度友好"""
        port = self.get_port(port_name)
        return self.transform @ port.get_local_transform() 
```

### 2.2 剥离动态状态：引入 `JointState`

将可变的运行状态（如用户拖拽产生的滑动距离）独立出来，保护 `ConnectionEdge` 定义的纯粹性。

```python
# 概念设计：connection_edge.py 中的组件
from dataclasses import dataclass

@dataclass
class JointState:
    """描述一个连接边在某一个时刻的物理动态状态"""
    insertion_depth: float = 0.0  # 沿 Z 轴的滑动距离 (实现拖拽动画的核心)
    rotation_angle: float = 0.0   # 绕 Z 轴的旋转角度 (针对 continuous 关节)

class ConnectionEdge:
    # ...
    def __init__(self, ...):
        self.state = JointState()  # 持有动态状态
```
极易实现撤销/重做 (Undo/Redo) 或关键帧动画。只需记录或修改 `JointState`，完全无需触碰底层拓扑。

### 2.3 引入 `Assembly`（装配体）承担系统级组装职责

引入 `Assembly` 概念。它是多个 `Part` 及其 `ConnectionEdge` 的集合。`Assembly` 同样可以作为一个整体暴露出对外的接口。

```python
# 概念设计：assembly.py
from typing import Dict, List
import networkx as nx
from part import Part
from connection_edge import ConnectionEdge

class Assembly:
    """
    代表一个装配体模块。
    它管理内部的零件以及零件之间的连接关系。
    """
    def __init__(self, assembly_id: str):
        self.assembly_id = assembly_id
        self.parts: Dict[str, Part] = {}
        self.connections: List[ConnectionEdge] = []
        self._kinematic_graph = nx.MultiDiGraph()

    def add_part(self, part: Part):
        self.parts[part.part_id] = part
        self._kinematic_graph.add_node(part.part_id, data=part)

    def connect_ports(self, edge: ConnectionEdge):
        """建立装配体内部的物理连接，包含安全校验"""
        if edge.parent_id not in self.parts or edge.child_id not in self.parts:
            raise ValueError("Cannot connect parts not in this assembly.")
            
        # 调用 Edge/Port 内聚的方法进行校验
        if not edge.is_physically_compatible():
            raise ValueError("Physical constraints prevent this connection.")
            
        self.connections.append(edge)
        self._kinematic_graph.add_edge(edge.parent_id, edge.child_id, data=edge)

    def resolve_kinematics(self) -> nx.DiGraph:
        """纯粹的图论算法：提取无环生成树 (Spanning Tree)"""
        pass
```
</core_design_rules>

---

## 3. 完美内聚的测试用例：长插销插入乐高梁孔

在这种解耦的架构下，你可以写出无需 3D 渲染、无需物理引擎的纯业务逻辑测试。这个测试像讲故事一样验证系统的健壮性。

```python
# 概念测试：tests/test_insertion.py
import numpy as np
from connection_interface import ConnectionInterface, Gender, Profile, FitType
from port import Port
from part import Part
from connection_edge import ConnectionEdge
from assembly import Assembly

def test_long_pin_insertion_lifecycle():
    # ... 省略代码，见前文 ...
    pass
```

## 4. 全新的概念层级总结

遵循 DDD (领域驱动设计)，重构后的核心层级将十分清晰：
1. **`ConnectionInterface`** (纯数据，查表法)：定义物理极限界限（我是谁，我多大）。
2. **`Port`** (纯几何)：持有接口，记录局部坐标和法线方向（我在哪，朝哪插）。
3. **`Part`** (结构容器)：管理自身的多个 Port，维护自身的绝对位置。
4. **`JointState`** (动态数据)：记录实时的插入深度和旋转角度。
5. **`ConnectionEdge`** (关系边)：持有两个 Port 的引用和 `JointState`，能计算当前的相对变换矩阵。
6. **`Assembly`** (装配图)：管理零件集和 ConnectionEdge，负责图论推导。

<negative_constraints>
- 绝对不要修改物理引擎 `physics_engine.py` 的底层调用机制，只在装配层和拓扑层做重构。
- 不要引入除 `numpy` 和 `networkx` 之外的任何第三方图论/数学计算库。
- 在修改 `server.py` 的 API 响应时，必须保留前端 `frontend/src/store.ts` 期望的基本字段（即使需要填入 mock 数据），绝不能因为后端精简导致前端崩溃。
</negative_constraints>

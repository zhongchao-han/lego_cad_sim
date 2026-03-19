# 端口 (Port) 的面向对象重构与设计指南

> **To Claude Code CLI:**
> Please read the following files into your context immediately. These files represent the core static knowledge and the existing codebase to be refactored. Reading them together now will help establish a stable context prefix for Prompt Caching, saving tokens in subsequent turns.
> 
> Required context files:
> - `docs/pin_hole_connection_design.md`
> - `docs/port_class_design.md`
> - `docs/assembly_hierarchy_design.md`
> - `port_semantics.py`
> - `topology_manager.py`
> - `server.py`
> - `port_library.py`
> - `port.py`

## 涉及的相关文件与目录

<architecture>
此设计指南直接影响并指导以下代码的重构：
- `port_library.py` (主要: `PortLibrary` 类用于从真理数据库加载端口)
- `port_semantics.py` (主要: 提供底层的 `ConnectionInterface` 数据结构与物理校验规则)
- `topology_manager.py` (主要: 移除硬编码的字符串猜测，改为调用 `Port` 对象的内聚方法)
- `server.py` (主要: 移除冗长的几何猜测如 `hole_axis = 1`，依赖 `Port` 的标准化坐标系)
- `tests/` (未来: 基于纯粹 `Port` 对象的无渲染、无引擎依赖单元测试)
</architecture>

---

<core_design_rules>
## 1. 核心设计理念：让“物理语义”与“空间位姿”组合 (Composition)

为了让端口的定义与 `pin_hole_connection_design.md` 中提出的“插头-插座（Plug-Socket）”理念自然衔接，我们需要将端口从一个“只有坐标和文件名的哑数据结构”，升格为一个**包含几何变换和物理接口语义的强类型对象**。

目前的 `ConnectionPort` 只有 `port_type` (字符串), `position` 和 `rotation`。重构后，我们应该将 `ConnectionInterface` 聚合进来，使其具有自描述的物理属性。

### 建议的代码结构：

```python
import numpy as np
from dataclasses import dataclass
from typing import Optional
from port_semantics import ConnectionInterface, get_interface, check_fit, FitType

@dataclass
class Port:
    """代表乐高零件上一个具体的连接点"""
    name: str                           # 端口别名/编号 (如: "hole_0")
    interface: ConnectionInterface      # 物理接口属性 (极性、形状、半径等)
    position: np.ndarray                # 局部坐标系下的位置 [x, y, z] (SI单位: m)
    rotation: np.ndarray                # 局部坐标系下的旋转矩阵 (3x3)
    
    @classmethod
    def from_raw(cls, name: str, ldraw_type: str, pos: np.ndarray, rot: np.ndarray, part_context: str = "") -> Optional["Port"]:
        """工厂方法 (从 LDraw 加载)：负责将 LDraw 的文件类型映射为标准接口，并对齐主轴"""
        interface = get_interface(ldraw_type)
        if not interface:
            return None 
        
        # 统一归一化：将主轴转换到标准的 +Z 方向
        normalized_rot = cls._normalize_insertion_axis(ldraw_type, rot)
        return cls(name=name, interface=interface, position=pos, rotation=normalized_rot)
        
    @staticmethod
    def _normalize_insertion_axis(ldraw_type: str, rot: np.ndarray) -> np.ndarray:
        """根据 ldraw_type 的原始定义，将主轴转换到标准的 +Z 方向"""
        # 例如：假设 peghole.dat 的孔轴原本是 Y 轴，则乘上特定旋转矩阵，将其拨到 Z 轴。
        # 这使得顶层逻辑无需再去猜测“孔是沿哪个轴方向”。
        return rot # 替换为具体的矩阵乘法变换逻辑
```

## 2. 逻辑内聚：让端口自己判定连接

与其在 `topology_manager.py` 或 `server.py` 中散布大量的 `if` 逻辑，不如将业务逻辑“内聚”到 `Port` 类本身。

```python
    # 续写 Port 类
    def test_fit_with(self, other: "Port") -> FitType:
        """测试自己能否与另一个端口插合 (语义与尺寸级别)"""
        return check_fit(self.interface, other.interface)

    def calculate_relative_transform(self, other: "Port", depth: float = 0.0) -> np.ndarray:
        """
        计算当两个端口的 Z 轴对齐（反向对扣）时，相对的 4x4 变换矩阵。
        参数 depth: 插入深度标量。
        返回: 相对变换矩阵 (4x4)
        """
        # 因为在工厂方法中已强制规范了 Z 轴为插入方向，
        # 所以此处的对齐算法将转化为极简的标准数学推导：
        # T_self * T_align = T_other * T_insert(depth)
        pass
```
</core_design_rules>

## 3. 设计优势分析

* **消除“隐式知识（Implicit Knowledge）”**：
  重构前系统各处散落着 `if "pin" in name` 或是 `hole_axis = 1 # 默认 Y 轴` 这种魔法逻辑。重构后，所有的 LDraw 原件怪癖（如哪根轴是主轴）都在 `create_from_ldraw` 这一道防线被统一消化。进入系统的 `Port` 对象都是标准化且干净的。
* **物理意义极其直观**：
  `Port` = “我在哪 (`position`)” + “我朝哪插 (`rotation` 的 Z 轴)” + “我是什么类型的接口 (`interface`)”。
* **严格遵循开闭原则 (OCP)**：
  如果未来需要添加“乐高齿轮（Gear）”或“万向节（Ball Joint）”的连接，只需扩展 `ConnectionInterface` 的注册表，而 `Port` 类本身的核心对齐与适配逻辑一行代码都不需要修改。

<testing_strategy>
## 4. 易于单元测试（无依赖剥离）

这种将“数据”与“渲染/引擎”完全解耦的设计，使得单元测试变得极其轻量和方便。开发者无需启动 Bullet 物理引擎或解析复杂的 LDraw 文件树，仅需 Mock 出两个 `Port` 即可验证数学和业务逻辑：

```python
# test_port_connections.py 示例
import numpy as np
from port_semantics import Gender, Profile, ConnectionInterface, FitType
# 假设 Port 类位于 topology_manager 或单独的 port.py 中
from module_where_port_is import Port 

def test_pin_to_hole_fit():
    # 模拟构建两个接口
    pin_iface = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 0.00236, 0.016)
    hole_iface = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 0.0024, 0.008)
    
    # 构造测试用 Port
    pin_port = Port("p1", pin_iface, np.zeros(3), np.eye(3))
    hole_port = Port("h1", hole_iface, np.zeros(3), np.eye(3))
    
    # 测试 1: 尺寸兼容性 (间隙配合)
    assert pin_port.test_fit_with(hole_port) == FitType.CLEARANCE
    
    # 测试 2: 极性排斥 (孔不能插孔)
    assert hole_port.test_fit_with(hole_port) == FitType.INCOMPATIBLE

def test_insertion_axis_normalization():
    # 假设 LDraw 的 peghole Y 轴是孔轴
    raw_rot = np.eye(3) # [0,1,0] 是 Y 轴
    port = Port.create_from_ldraw("h1", "peghole.dat", np.zeros(3), raw_rot)
    
    # 验证工厂方法是否正确地将孔轴映射到了 Z 轴 [0,0,1]
    z_axis = port.rotation[:, 2] 
    # np.testing.assert_allclose(z_axis, [0, 0, 1], atol=1e-6)
```
</testing_strategy>

<negative_constraints>
- 在修改 `ldraw_parser.py` 时，不要改变 `ConnectionPort` 向上游传递的基本字典格式（如 `to_dict()` 的结构），否则会导致前端依赖的解析失败。你可以新增功能，但要兼容旧有属性。
- 绝不可以在 `Port` 类中引入任何网络库或前端 UI 代码。
</negative_constraints>

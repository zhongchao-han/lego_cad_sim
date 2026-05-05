"""
connection_edge.py
==================
ConnectionEdge — 描述两个零件端口之间的物理连接关系。
JointState     — 连接边的运行时动态状态（插入深度、旋转角度）。

设计依据 docs/assembly_hierarchy_design.md §2.2：
  将可变的运行状态独立出来，保护 ConnectionEdge 定义的纯粹性。
  极易实现撤销/重做（只需记录或修改 JointState），无需触碰底层拓扑。
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend.port import Port


# ---------------------------------------------------------------------------
# JointState — 运行时动态状态
# ---------------------------------------------------------------------------

@dataclass
class JointState:
    """
    描述一个连接边在某一时刻的物理动态状态。

    与 ConnectionEdge 的结构定义解耦，使得 Undo/Redo 或关键帧动画
    只需序列化/反序列化 JointState，不需要重建拓扑。
    """
    insertion_depth: float = 0.0  # 沿 Z 轴的插入深度（m）；0 = 完全插到底
    rotation_angle:  float = 0.0  # 绕 Z 轴的旋转角度（rad）；适用于 continuous 关节


# ---------------------------------------------------------------------------
# ConnectionEdge — 连接边
# ---------------------------------------------------------------------------

class ConnectionEdge:
    """
    描述两个零件端口之间的物理连接。

    持有 Port 对象而非裸字符串 + 向量，所有物理逻辑（关节类型推导、
    相对变换计算）都委托给 Port 本身的方法，拓扑层无需再关心轴向约定。

    持有 JointState 描述运行时状态，支持撤销/重做（只需记录/修改 state）。
    """

    def __init__(
        self,
        parent_id:   str,
        child_id:    str,
        port_parent: "Port",
        port_child:  "Port",
    ):
        self.parent_id   = parent_id
        self.child_id    = child_id
        self.port_parent = port_parent   # 父零件侧的端口
        self.port_child  = port_child    # 子零件侧的端口

        # 运行时动态状态（独立可序列化）
        self.state = JointState()

        # 多重连接合并标记（过约束 → Fixed Joint）
        self.is_merged = False

    # ------------------------------------------------------------------ #
    # 物理校验
    # ------------------------------------------------------------------ #

    def is_physically_compatible(self) -> bool:
        """
        检验两端口的物理接口是否可插合（极性互补 + 截面相同 + 无几何干涉）。
        """
        from backend.port_semantics import FitType
        fit = self.port_parent.test_fit_with(self.port_child)
        return fit not in (FitType.INCOMPATIBLE, FitType.BLOCKED)

    # ------------------------------------------------------------------ #
    # 调试
    # ------------------------------------------------------------------ #

    def __repr__(self) -> str:
        return (
            f"ConnectionEdge({self.parent_id!r} → {self.child_id!r}, "
            f"merged={self.is_merged}, depth={self.state.insertion_depth:.4f}m)"
        )

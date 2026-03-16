"""
part.py
=======
Part — 代表一个独立的乐高零件实体。

设计依据 docs/assembly_hierarchy_design.md §2.1：
  让 Part 成为内聚管理自身 Port 的容器。
  它不知道外界（Assembly）的存在，只对自身的几何变换负责。
"""

from typing import Dict, Optional

import numpy as np

from port import Port


class Part:
    """
    代表一个独立的乐高零件实体（例如：一根 3 孔梁）。

    职责边界：
      - 持有并管理自身的所有 Port（内聚）
      - 维护零件在全局/父级坐标系下的绝对位姿（4×4 transform）
      - 不知道外界（Assembly）的存在
    """

    def __init__(self, part_id: str, name: str, mass: float = 0.001):
        self.part_id = part_id
        self.name    = name
        self.mass    = mass

        # 零件在全局/父级坐标系下的绝对位姿（4×4 齐次变换矩阵）
        self.transform: np.ndarray = np.eye(4)

        # 核心内聚：Part 拥有并管理自己的 Ports
        self.ports: Dict[str, Port] = {}

    # ------------------------------------------------------------------ #
    # Port 管理
    # ------------------------------------------------------------------ #

    def add_port(self, port: Port) -> None:
        """注册一个端口到此零件。"""
        self.ports[port.name] = port

    def get_port(self, port_name: str) -> Optional[Port]:
        """按名称取出端口；不存在则返回 None。"""
        return self.ports.get(port_name)

    # ------------------------------------------------------------------ #
    # 几何计算（内聚，便于无依赖单元测试）
    # ------------------------------------------------------------------ #

    def get_port_global_transform(self, port_name: str) -> np.ndarray:
        """
        计算指定端口在全局坐标系下的 4×4 变换矩阵。

            T_global = self.transform @ T_port_local

        Raises:
            KeyError: 端口名称不存在。
        """
        port = self.get_port(port_name)
        if port is None:
            raise KeyError(f"Port {port_name!r} not found in part {self.part_id!r}")
        T_local = np.eye(4)
        T_local[:3, :3] = port.rotation
        T_local[:3, 3]  = port.position
        return self.transform @ T_local

    def get_port_global_position(self, port_name: str) -> np.ndarray:
        """返回端口在全局坐标系下的 3D 位置（m）。"""
        return self.get_port_global_transform(port_name)[:3, 3]

    def get_port_global_insertion_axis(self, port_name: str) -> np.ndarray:
        """
        返回端口在全局坐标系下的插入方向单位向量（Z 轴）。
        仅取旋转部分的 Z 列，不受平移影响。
        """
        T = self.get_port_global_transform(port_name)
        return T[:3, 2]

    # ------------------------------------------------------------------ #
    # 调试
    # ------------------------------------------------------------------ #

    def __repr__(self) -> str:
        return f"Part({self.part_id!r}, {self.name!r}, ports={list(self.ports.keys())})"


# ---------------------------------------------------------------------------
# 自测
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=== part.py 自测 ===\n")

    from connection_interface import ConnectionInterface, Gender, Profile, LDU

    # 构建一个带两个孔端口的梁
    beam = Part("beam_A", "3x3_beam")

    hole_iface = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 6.0 * LDU, 20.0 * LDU)
    h0 = Port("hole_0", hole_iface, np.array([0.0, 0.0, 0.0]), np.eye(3), port_type="peghole.dat")
    h1 = Port("hole_1", hole_iface, np.array([0.008, 0.0, 0.0]), np.eye(3), port_type="peghole.dat")

    beam.add_port(h0)
    beam.add_port(h1)

    # 1. 端口查询
    assert beam.get_port("hole_0") is h0
    assert beam.get_port("missing") is None
    print("[端口查询] OK")

    # 2. 全局变换（transform 为单位阵时，等于局部变换）
    T = beam.get_port_global_transform("hole_0")
    assert T.shape == (4, 4)
    np.testing.assert_allclose(T[:3, 3], [0.0, 0.0, 0.0], atol=1e-9)
    print("[全局变换] hole_0 位置 OK")

    # 3. 零件平移后，全局位置应随之偏移
    beam.transform[0, 3] = 0.016  # 沿 X 移动 16mm
    pos = beam.get_port_global_position("hole_1")
    np.testing.assert_allclose(pos, [0.016 + 0.008, 0.0, 0.0], atol=1e-9)
    print(f"[平移后全局位置] hole_1 = {pos.tolist()} OK")

    # 4. KeyError
    try:
        beam.get_port_global_transform("nonexistent")
        assert False, "应抛出 KeyError"
    except KeyError:
        print("[KeyError] OK")

    print(f"\n{beam!r}")
    print("\n[所有断言通过 OK]")

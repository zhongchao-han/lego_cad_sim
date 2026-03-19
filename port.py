"""
port.py
=======
Port — 具有物理语义的强类型端口对象。

设计依据 docs/port_class_design.md：
  - 将 ConnectionInterface (物理语义) 与空间位姿组合（Composition）
  - 工厂方法统一消化 LDraw 原件的轴向差异，返回的 Port 的 Z 轴正方向
    必定是"插入方向"（Insertion Vector）
  - 逻辑内聚：端口自己判定配合类型、计算对齐变换
  - 与渲染/引擎完全解耦，便于无依赖单元测试
"""

import numpy as np
import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, Tuple

from port_semantics import (
    ConnectionInterface, Gender, Profile, FitType,
    get_interface, check_fit, derive_joint_params,
)
from core_constants import LDU

# 配置日志
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 插入轴归一化矩阵
# ---------------------------------------------------------------------------
# 约定：Port.rotation 的 Z 列（即 rotation[:, 2]）= 插入方向单位向量
#
# LDraw 原件的原始定义：插入轴沿 Y 轴
#   FEMALE（孔）：-Y = 孔开口/外部方向  → 令 Z = -Y
#     normalizer = Rx(+90°)
#   MALE（销/轴）：-Y = 销突出方向      → 令 Z = -Y
#     normalizer = Rx(+90°)
#
# 矩阵约定（后乘）：R_norm = R_ldraw @ normalizer
#   则 R_norm[:, 2] = R_ldraw @ normalizer[:, 2] = R_ldraw @ target_axis
#
# 验证：
#   Rx(+90°)[:, 2] = [0,-1, 0] = -Y  → Z = R_ldraw 的 -Y 列（-Y）
#   (注：之前 FEMALE 使用 Rx(-90°) 映射到 +Y 导致指向了零件内部)

_Rx_POS90: np.ndarray = np.array(
    [[1,  0,  0],
     [0,  0, -1],
     [0,  1,  0]], dtype=float
)  # Rx(+90°)：归一化矩阵，映射 LDraw 的 -Y 到 Z+

# MALE ↔ FEMALE 对合条件（连接后 Z_plug = -Z_socket）：
# 绕 X 轴旋转 180° 可将 Z 翻转：Z → -Z，同时翻转 Y。
_R_FLIP_Z: np.ndarray = np.array(
    [[1,  0,  0],
     [0, -1,  0],
     [0,  0, -1]], dtype=float
)

# 每种 LDraw 原件对应的归一化矩阵
_NORMALIZER_MAP: Dict[str, np.ndarray] = {
    # FEMALE（孔）—— 统一使用 Rx(+90°)，使 Z 指向 -Y_ldraw (开口向外)
    "peghole":          _Rx_POS90,
    "peghole.dat":      _Rx_POS90,
    "axlehole":         _Rx_POS90,
    "axlehole.dat":     _Rx_POS90,
    "axleholepin.dat":  _Rx_POS90,
    # MALE（销/轴）—— 使用 Rx(+90°)，使 Z 指向 -Y_ldraw (突出向外)
    "peg":              _Rx_POS90,
    "pin":              _Rx_POS90,
    "pin.dat":          _Rx_POS90,
    "halfpin.dat":      _Rx_POS90,
    "connect.dat":      _Rx_POS90,
    "fric_pin.dat":     _Rx_POS90,
    "axle":             _Rx_POS90,
    "axle.dat":         _Rx_POS90,
    "pin_friction":     _Rx_POS90,
}

# 默认接口（用于 create_fallback，type 含 "hole" → FEMALE，否则 → MALE）
_DEFAULT_FEMALE = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 6.0 * LDU, 20.0 * LDU)
_DEFAULT_MALE   = ConnectionInterface(Gender.MALE,   Profile.CYLINDER, 5.9 * LDU, 40.0 * LDU)


# ---------------------------------------------------------------------------
# Port 类
# ---------------------------------------------------------------------------

@dataclass
class Port:
    """
    代表乐高零件上一个具体的连接点。

    Attributes:
        name:      端口标识符，如 "hole_0"
        interface: 物理接口语义（极性、形状、尺寸）
        position:  局部坐标系下的位置，SI 单位（m），shape (3,)
        rotation:  局部坐标系下的 3×3 旋转矩阵（Z 列 = 插入方向）
        port_type: 原始 LDraw 类型字符串，保留供序列化使用
    """
    name:      str
    interface: ConnectionInterface
    position:  np.ndarray  # (3,)
    rotation:  np.ndarray  # (3, 3)，Z 轴 = 插入方向（已归一化）
    port_type: str = ""    # 原始 LDraw 类型名，用于 to_dict() 兼容旧接口

    # ------------------------------------------------------------------ #
    # 工厂方法
    # ------------------------------------------------------------------ #

    @classmethod
    def from_raw(
        cls,
        name:       str,
        ldraw_type: str,
        pos:        np.ndarray,
        rot:        np.ndarray,
        part_context: str = "Unknown Part"
    ) -> Optional["Port"]:
        """
        [数据入库端专用] 从 LDraw 原始数据创建端口，并执行轴向归一化。
        该方法会将 LDraw 的 -Y 映射为 Z+ (插入方向)，并纠正镜像错误。
        """
        iface = get_interface(ldraw_type)
        if iface is None:
            logger.critical(
                f"\n{'!'*60}\n"
                f"MISSING SEMANTIC DATA: 发现未解析的连接原件!\n"
                f"零件: {part_context}\n"
                f"原件: {ldraw_type}\n"
                f"原因: 该 .dat 文件尚未在 connection_interface.py 中定义其物理特性(Gender/Fit/Radius)。\n"
                f"结果: 该端口将被系统忽略，吸附功能可能无法正常工作。\n"
                f"{'!'*60}\n"
            )
            return None

        normalized_rot = cls._normalize_insertion_axis(ldraw_type, rot)
        if normalized_rot is None:
             logger.error(f"FAIL TO NORMALIZE: 原件 {ldraw_type} 缺少归一化矩阵映射。")
             return None

        # 核心修复：强制转换为右手正交系，防止 LDraw 镜像导致前端/物理引擎崩溃
        final_rot = cls._ensure_right_handed(normalized_rot)

        return cls(
            name=name,
            interface=iface,
            position=pos,
            rotation=final_rot,
            port_type=ldraw_type,
        )

    @classmethod
    def from_config(
        cls,
        name:       str,
        ldraw_type: str,
        pos:        np.ndarray,
        rot:        np.ndarray,
    ) -> Optional["Port"]:
        """
        [运行时专用] 从已经归一化好的 JSON 配置创建端口。
        直接信任输入数据，不再进行二次轴向变换。
        """
        iface = get_interface(ldraw_type)
        if iface is None:
            return None # 运行时由于已经过验证，通常不会走到这里
            
        return cls(
            name=name,
            interface=iface,
            position=pos,
            rotation=rot,
            port_type=ldraw_type,
        )

    # ------------------------------------------------------------------ #
    # 内部辅助
    # ------------------------------------------------------------------ #

    @staticmethod
    def _normalize_insertion_axis(ldraw_type: str, rot: np.ndarray) -> np.ndarray:
        """
        后乘归一化矩阵，将插入轴拨到 Z+ 方向。

        R_norm = R_ldraw @ normalizer
        R_norm[:, 2] = R_ldraw @ normalizer[:, 2] = R_ldraw @ target_axis

        未知类型：原样返回，不做变换。
        """
        normalizer = _NORMALIZER_MAP.get(ldraw_type.lower().strip())
        if normalizer is None:
            return rot.copy()
        return rot @ normalizer

    @staticmethod
    def _ensure_right_handed(rot: np.ndarray) -> np.ndarray:
        """
        强制将矩阵转换为标准右手正交矩阵 (SO(3))。
        保持 Z 轴（插入方向）绝对不动，重新构建 X 和 Y。
        """
        # 1. 提取原始 Z 轴并归一化（这是我们的主轴）
        z = rot[:, 2]
        z = z / (np.linalg.norm(z) + 1e-12)

        # 2. 尝试提取原始 Y 轴
        y_orig = rot[:, 1]
        
        # 3. 如果 Y 与 Z 平行（极罕见），选择一个备用轴
        if abs(np.dot(y_orig, z)) > 0.99:
            y_orig = np.array([1.0, 0.0, 0.0]) if abs(z[0]) < 0.9 else np.array([0.0, 1.0, 0.0])

        # 4. 构建相互垂直的 X, Y
        # X = Y_orig cross Z
        x = np.cross(y_orig, z)
        x = x / (np.linalg.norm(x) + 1e-12)
        
        # Y = Z cross X (确保三者构成右手系)
        y = np.cross(z, x)
        
        # 5. 组装新矩阵
        new_rot = np.zeros((3, 3))
        new_rot[:, 0] = x
        new_rot[:, 1] = y
        new_rot[:, 2] = z
        
        return new_rot

    # ------------------------------------------------------------------ #
    # 属性
    # ------------------------------------------------------------------ #

    @property
    def insertion_axis(self) -> np.ndarray:
        """
        插入方向的单位向量（= rotation 矩阵第 3 列，即 Z 轴）。

        约定：Z 轴始终指向零件"外部"（开口向外或销/轴突出向外）。
        连接条件：在各自局部坐标系下 Z 轴同向，连接计算时通过 T_flip 实现反向对扣。
        """
        return self.rotation[:, 2]

    @property
    def gender(self) -> Gender:
        return self.interface.gender

    @property
    def profile(self) -> Profile:
        return self.interface.profile

    # ------------------------------------------------------------------ #
    # 物理逻辑（内聚）
    # ------------------------------------------------------------------ #

    def test_fit_with(self, other: "Port") -> FitType:
        """
        判断自己能否与另一个端口插合（语义 + 尺寸双重校验）。

        自动处理 plug/socket 极性顺序（check_fit 要求第一个参数为 MALE）：
          - 极性互补（MALE + FEMALE）且截面形状匹配 → CLEARANCE / FRICTION / BLOCKED
          - 极性相同或形状不匹配                    → INCOMPATIBLE
        """
        if self.gender == Gender.MALE and other.gender == Gender.FEMALE:
            return check_fit(self.interface, other.interface)
        elif self.gender == Gender.FEMALE and other.gender == Gender.MALE:
            return check_fit(other.interface, self.interface)
        else:
            return FitType.INCOMPATIBLE

    def derive_joint(
        self,
        other: "Port",
        is_overconstrained: bool = False,
    ) -> Tuple[str, float, float]:
        """
        由两端口的接口类型推导 URDF 物理关节参数。

        自动处理 plug/socket 极性顺序，委托 derive_joint_params 完成。

        Returns:
            (joint_type, damping, friction_torque)
        """
        if self.gender == Gender.MALE and other.gender == Gender.FEMALE:
            plug, socket = self.interface, other.interface
        elif self.gender == Gender.FEMALE and other.gender == Gender.MALE:
            plug, socket = other.interface, self.interface
        else:
            return "fixed", 0.0, 0.0
        return derive_joint_params(plug, socket, is_overconstrained)

    def calculate_relative_transform(
        self,
        other: "Port",
        depth: float = 0.0,
    ) -> np.ndarray:
        """
        计算当两端口 Z 轴反向对扣（插合）时，other 所属零件原点在
        self 所属零件坐标系中的 4×4 变换矩阵。

        因工厂方法已将 Z 轴统一为插入方向，对齐算法退化为极简推导：

            T_rel = T_self @ T_flip_Z @ T_depth @ inv(T_other)

        其中：
            T_self   — self  端口在其所属零件坐标系下的位姿
            T_flip_Z — 绕 X 轴旋转 180°，令 Z_child → -Z_parent（反向对扣）
            T_depth  — 沿对齐后 Z 轴平移 depth（插入深度；0 = 完全插到底）
            T_other  — other 端口在其所属零件坐标系下的位姿（求逆后消去）

        Args:
            other: 待对齐的另一端口（通常极性与 self 互补）。
            depth: 插入深度，单位 m。取值范围 [0, min(plug.depth, socket.depth)]。

        Returns:
            4×4 ndarray：other 所属零件原点相对于 self 所属零件的变换。
        """
        T_self = np.eye(4)
        T_self[:3, :3] = self.rotation
        T_self[:3, 3]  = self.position

        T_other = np.eye(4)
        T_other[:3, :3] = other.rotation
        T_other[:3, 3]  = other.position

        T_flip = np.eye(4)
        T_flip[:3, :3] = _R_FLIP_Z       # Z → -Z（反向对扣）

        T_depth = np.eye(4)
        T_depth[2, 3] = depth             # 沿 Z 方向插入 depth 米

        return T_self @ T_flip @ T_depth @ np.linalg.inv(T_other)

    # ------------------------------------------------------------------ #
    # 序列化（向后兼容 ConnectionPort.to_dict()）
    # ------------------------------------------------------------------ #

    def to_dict(self) -> dict:
        """
        返回与旧 ConnectionPort.to_dict() 格式兼容的字典。
        'type' 字段保留原始 LDraw 类型字符串，前端 Scene.jsx 依赖其判断
        'peghole' 还是 'peg'（通过 .includes('hole') 检查）。
        """
        return {
            "type":     self.port_type,
            "position": self.position.tolist(),
            "rotation": self.rotation.tolist(),
        }

    def __repr__(self) -> str:
        ax = self.insertion_axis
        return (
            f"Port({self.name!r}, {self.gender.value}/{self.profile.value}, "
            f"r={self.interface.radius * 1000:.2f}mm, "
            f"ins_axis=[{ax[0]:.2f},{ax[1]:.2f},{ax[2]:.2f}])"
        )


# ---------------------------------------------------------------------------
# 自测
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=== port.py 自测 ===\n")

    # 1. 工厂方法：已注册类型
    hole = Port.from_raw("h0", "peghole.dat", np.zeros(3), np.eye(3))
    pin  = Port.from_raw("p0", "pin.dat",     np.zeros(3), np.eye(3))
    assert hole is not None and pin is not None, "已注册类型应成功创建"

    # 2. Z 轴归一化验证
    # 无论 MALE 还是 FEMALE，Z 轴现在都应指向 -Y_ldraw = [0, -1, 0] (开口/突出向外)
    assert np.allclose(hole.insertion_axis, [0, -1, 0], atol=1e-9), \
        f"FEMALE Z 应为 [0,-1,0]，实际：{hole.insertion_axis}"
    assert np.allclose(pin.insertion_axis, [0, -1, 0], atol=1e-9), \
        f"MALE Z 应为 [0,-1,0]，实际：{pin.insertion_axis}"

    # 3. 极性与形状提取
    assert hole.gender == Gender.FEMALE and hole.profile == Profile.CYLINDER
    assert pin.gender == Gender.MALE and pin.profile == Profile.CYLINDER
    print("[工厂方法与归一化] Z 轴对齐 OK")

    # 4. Fit Test
    assert hole.test_fit_with(pin) == FitType.CLEARANCE
    assert pin.test_fit_with(hole) == FitType.CLEARANCE  # 自动处理顺序
    assert hole.test_fit_with(hole) == FitType.INCOMPATIBLE
    print("[test_fit_with] clearance / incompatible OK")

    # 5. derive_joint
    j, d, f_ = pin.derive_joint(hole)
    assert j == "continuous" and d == 0.05
    j2, d2, _ = hole.derive_joint(pin)          # 顺序互换应相同
    assert j2 == "continuous" and d2 == 0.05
    print(f"[derive_joint] type={j}, damping={d}")

    # 6. 摩擦销
    fpin = Port.from_raw("fp", "fric_pin.dat", np.zeros(3), np.eye(3))
    assert fpin is not None
    assert fpin.test_fit_with(hole) == FitType.FRICTION
    jf, df, _ = fpin.derive_joint(hole)
    assert jf == "continuous" and df == 1.5
    print(f"[摩擦销] type={jf}, damping={df}")

    # 7. 十字轴
    axle     = Port.from_raw("ax", "axle.dat",     np.zeros(3), np.eye(3))
    axlehole = Port.from_raw("ah", "axlehole.dat", np.zeros(3), np.eye(3))
    assert axle is not None and axlehole is not None
    assert axle.test_fit_with(axlehole) == FitType.CLEARANCE
    jax, _, _ = axle.derive_joint(axlehole)
    assert jax == "fixed"
    print(f"[十字轴] type={jax}")

    # 8. 未知类型 → None
    unknown = Port.from_raw("u", "unknown_part.dat", np.zeros(3), np.eye(3))
    assert unknown is None
    print("[未知类型] returns None OK")

    # 9. calculate_relative_transform（烟雾测试：结果为 4×4 矩阵）
    T = hole.calculate_relative_transform(pin)
    assert T.shape == (4, 4)
    print(f"[相对变换] shape={T.shape}")

    # 10. to_dict 向后兼容
    d = hole.to_dict()
    assert "type" in d and "position" in d and "rotation" in d
    assert d["type"] == "peghole.dat"
    print(f"[to_dict] type={d['type']}")

    # 11. 镜像矩阵稳健性（LDraw 常见：det = -1）
    # 构造一个在 X 轴镜像的旋转矩阵
    mirrored_rot = np.array([[-1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=float)
    m_hole = Port.from_raw("mh", "peghole.dat", np.zeros(3), mirrored_rot)
    assert m_hole is not None
    # 验证输出矩阵是右手系 (det ≈ 1)
    assert np.linalg.det(m_hole.rotation) > 0, "输出矩阵必须是右手系"
    # 验证 Z 轴依然正确（identity_rot 的 -Y 经过镜像仍然是 [0, -1, 0]）
    # 但如果是 R_ldraw @ Rx(+90)，则 Z = R_ldraw[:, 1] (LDraw 的 -Y)
    # mirrored_rot 的第 2 列是 [0, 1, 0]，所以 R @ Rx(+90) 后的 Z 应该是 [0, -1, 0]
    assert np.allclose(m_hole.insertion_axis, [0, -1, 0], atol=1e-9), \
        f"镜像后 Z 轴应维持正确，实际：{m_hole.insertion_axis}"
    print("[镜像稳健性] det > 0 且 Z 轴正确 OK")

    print("\n[所有断言通过 OK]")

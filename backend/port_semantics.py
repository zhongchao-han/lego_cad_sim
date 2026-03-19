"""
port_semantics.py
=================
基于"插头-插座（Plug-Socket）"类型化系统的连接接口定义与配合逻辑。
"""

from enum import Enum
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from core_constants import LDU

# 配合公差（SI 单位，米）
# 真实 ABS 塑料可承受约 0.1-0.3mm 径向变形
DELTA_FRICTION_MAX = 0.0003   # 0.3mm 以内为摩擦/过盈配合
DELTA_BLOCKED_MIN  = 0.0003   # 超过此值则几何干涉，无法插入


# ---------------------------------------------------------------------------
# 枚举类型
# ---------------------------------------------------------------------------

class Gender(Enum):
    """接口极性：公头（插头）或母头（插座）"""
    MALE   = "MALE"    # 插头 / 销 / 轴
    FEMALE = "FEMALE"  # 插座 / 孔


class Profile(Enum):
    """接口截面形状：决定物理关节的自由度"""
    CYLINDER = "CYLINDER"  # 圆柱销孔 -> 1 DoF 旋转 (Revolute Joint)
    CROSS    = "CROSS"     # 十字轴孔 -> 0 DoF (Fixed Joint)
    STUD     = "STUD"      # 乐高凸起/反凸起 -> 0 DoF (Fixed Joint)


class FitType(Enum):
    """配合类型"""
    CLEARANCE    = "clearance"    # 间隙配合：可自由滑入
    FRICTION     = "friction"     # 摩擦配合：紧密贴合，需一定力
    INTERFERENCE = "interference" # 过盈配合：需压入（保留以兼容旧逻辑）
    BLOCKED      = "blocked"      # 几何干涉：无法插入
    INCOMPATIBLE = "incompatible" # 接口不兼容（极性或形状不匹配）


# ---------------------------------------------------------------------------
# 接口数据类
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ConnectionInterface:
    """
    标准化连接接口描述符。

    Attributes:
        gender:  接口极性（MALE/FEMALE）
        profile: 截面形状（CYLINDER/CROSS/STUD）
        radius:  有效半径，单位 m（销的外壁半径 / 孔的内壁半径）
        depth:   深度/长度，单位 m（MALE=插入有效长度，FEMALE=孔深）
    """
    gender:  Gender
    profile: Profile
    radius:  float   # 单位：m
    depth:   float   # 单位：m


# ---------------------------------------------------------------------------
# 标准化接口注册表（查表法核心）
# ---------------------------------------------------------------------------
# 覆盖来自 LDraw 语义原件文件名（ldraw_parser.py）和前端简化类型名（store.ts）。
# 乐高 Technic 体系高度标准化，绝大多数连接可直接从此表查出，无需网格计算。

INTERFACE_REGISTRY: Dict[str, ConnectionInterface] = {

    # ── FEMALE（孔）──────────────────────────────────────────────────────────
    # 标准圆孔：半径 6.0 LDU = 2.4mm，孔深 = 梁厚 20 LDU = 8mm
    "peghole":      ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 6.0 * LDU, 20.0 * LDU),
    "peghole.dat":  ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 6.0 * LDU, 20.0 * LDU),

    # 十字轴孔：用于锁定轴的旋转
    "axlehole":     ConnectionInterface(Gender.FEMALE, Profile.CROSS,    4.0 * LDU, 20.0 * LDU),
    "axlehole.dat": ConnectionInterface(Gender.FEMALE, Profile.CROSS,    4.0 * LDU, 20.0 * LDU),

    # 带销孔的连接件（部分乐高零件同时具备圆孔和十字孔功能）
    "axleholepin.dat": ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 6.0 * LDU, 20.0 * LDU),

    # ── MALE（销/轴）────────────────────────────────────────────────────────
    # 普通销（间隙配合）：半径 5.9 LDU < 孔半径 6.0 LDU，可自由旋转
    "peg":          ConnectionInterface(Gender.MALE, Profile.CYLINDER, 5.9 * LDU, 40.0 * LDU),
    "pin":          ConnectionInterface(Gender.MALE, Profile.CYLINDER, 5.9 * LDU, 40.0 * LDU),
    "pin.dat":      ConnectionInterface(Gender.MALE, Profile.CYLINDER, 5.9 * LDU, 40.0 * LDU),

    # 半销：长度为梁厚一半
    "halfpin.dat":  ConnectionInterface(Gender.MALE, Profile.CYLINDER, 5.9 * LDU, 20.0 * LDU),

    # Technic 销连接原件（connect.dat）：4274/3673 等半销的核心语义原件
    "connect.dat":  ConnectionInterface(Gender.MALE, Profile.CYLINDER, 5.9 * LDU, 20.0 * LDU),

    # 摩擦销（friction pin）：半径 6.2 LDU > 孔半径 6.0 LDU，形成摩擦配合
    # LDraw 中对应 6558.dat 等（摩擦脊在模型中被夸大，实际阻尼由物理引擎注入）
    "fric_pin.dat": ConnectionInterface(Gender.MALE, Profile.CYLINDER, 6.2 * LDU, 40.0 * LDU),
    "pin_friction": ConnectionInterface(Gender.MALE, Profile.CYLINDER, 6.2 * LDU, 40.0 * LDU),

    # 十字轴：锁定旋转
    "axle":         ConnectionInterface(Gender.MALE, Profile.CROSS, 3.9 * LDU, 40.0 * LDU),
    "axle.dat":     ConnectionInterface(Gender.MALE, Profile.CROSS, 3.9 * LDU, 40.0 * LDU),
}


# ---------------------------------------------------------------------------
# 核心逻辑函数
# ---------------------------------------------------------------------------

def get_interface(port_type: str) -> Optional[ConnectionInterface]:
    """
    从注册表中查找接口定义。不区分大小写，去除前后空白。
    未知零件返回 None，调用方应降级到几何检测。
    """
    return INTERFACE_REGISTRY.get(port_type.lower().strip())


def check_fit(plug: ConnectionInterface, socket: ConnectionInterface) -> FitType:
    """
    参数化配合检测（O(1) 时间复杂度，替代 O(n) 网格切片）。

    配合判定公式：Delta = plug.radius - socket.radius
      Delta <= 0             -> 间隙配合（Clearance）
      0 < Delta <= 0.3mm     -> 摩擦配合（Friction）
      Delta > 0.3mm          -> 几何干涉（Blocked）

    前置条件：极性互补（MALE + FEMALE）且截面形状相同。
    """
    if plug.gender != Gender.MALE or socket.gender != Gender.FEMALE:
        return FitType.INCOMPATIBLE
    if plug.profile != socket.profile:
        return FitType.INCOMPATIBLE

    delta = plug.radius - socket.radius
    if delta <= 0.0:
        return FitType.CLEARANCE
    elif delta <= DELTA_FRICTION_MAX:
        return FitType.FRICTION
    else:
        return FitType.BLOCKED


def derive_joint_params(
    plug: ConnectionInterface,
    socket: ConnectionInterface,
    is_overconstrained: bool = False,
) -> Tuple[str, float, float]:
    """
    由接口类型直接推导 URDF 关节类型和物理阻尼参数。

    规则：
      过约束（多销连接同一对零件）         -> fixed
      CYLINDER + CYLINDER (间隙) -> continuous，低阻尼
      CYLINDER + CYLINDER (摩擦) -> continuous，高阻尼（注入摩擦感）
      CROSS    + CROSS            -> fixed（轴锁止无自由度）
      不兼容                       -> fixed（保守降级）

    Returns:
        (joint_type, damping, friction_torque)  单位：SI（N·m·s / N·m）
    """
    if is_overconstrained:
        return "fixed", 0.0, 0.0

    fit = check_fit(plug, socket)
    if fit == FitType.INCOMPATIBLE:
        return "fixed", 0.0, 0.0

    if plug.profile == Profile.CYLINDER and socket.profile == Profile.CYLINDER:
        if fit == FitType.FRICTION:
            # 摩擦销：注入高阻尼，模拟 ABS 塑料变形产生的阻力
            return "continuous", 1.5, 1.5
        else:
            # 普通销：低阻尼，可自由旋转
            return "continuous", 0.05, 0.05

    if plug.profile == Profile.CROSS and socket.profile == Profile.CROSS:
        return "fixed", 0.0, 0.0

    if plug.profile == Profile.STUD and socket.profile == Profile.STUD:
        return "fixed", 0.0, 0.0

    return "fixed", 0.0, 0.0


def build_fit_result(
    plug: ConnectionInterface,
    socket: ConnectionInterface,
    peg_id: str,
    hole_id: str,
    beam_thickness: Optional[float] = None,
) -> dict:
    """
    构造与旧版 /api/insertion_check 相同格式的响应字典。
    用于将参数化结果无缝替换旧的网格切片结果。
    """
    fit = check_fit(plug, socket)
    effective_beam = beam_thickness if beam_thickness is not None else socket.depth
    can_fully_insert = (fit != FitType.BLOCKED and fit != FitType.INCOMPATIBLE
                        and plug.depth >= effective_beam)

    delta = plug.radius - socket.radius
    interference_mm  = round(delta * 1000, 3)
    interference_pct = round((delta / socket.radius * 100) if socket.radius > 0 else 0.0, 1)

    return {
        "peg_id":               peg_id,
        "hole_id":              hole_id,
        "peg_axis":             0,
        "hole_axis":            1,
        "peg_length":           round(plug.depth, 6),
        "hole_radius":          round(socket.radius, 6),
        "peg_min_radius":       round(plug.radius, 6),
        "peg_max_radius":       round(plug.radius, 6),
        "beam_thickness":       round(effective_beam, 6),
        "max_passable_length":  round(plug.depth, 6) if can_fully_insert else 0.0,
        "can_fully_insert":     can_fully_insert,
        "fit_type":             fit.value,
        "interference_mm":      interference_mm,
        "interference_pct":     interference_pct,
        "optimal_center_offset": 0.0,
        "method":               "parametric",  # 标记为参数化查表（非网格切片）
    }


# ---------------------------------------------------------------------------
# 自测
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=== connection_interface.py 自测 ===\n")

    # 1. 普通销插入标准孔 -> 间隙配合 -> continuous 低阻尼
    pin   = get_interface("pin.dat")
    hole  = get_interface("peghole.dat")
    assert pin  is not None
    assert hole is not None
    fit = check_fit(pin, hole)
    jtype, damp, fric = derive_joint_params(pin, hole)
    print(f"[普通销→标准孔]  配合={fit.value}, 关节={jtype}, 阻尼={damp}")
    assert fit   == FitType.CLEARANCE
    assert jtype == "continuous"
    assert damp  == 0.05

    # 2. 摩擦销插入标准孔 -> 摩擦配合 -> continuous 高阻尼
    fpin = get_interface("fric_pin.dat")
    assert fpin is not None
    fit2 = check_fit(fpin, hole)
    jtype2, damp2, _ = derive_joint_params(fpin, hole)
    print(f"[摩擦销→标准孔]  配合={fit2.value}, 关节={jtype2}, 阻尼={damp2}")
    assert fit2   == FitType.FRICTION
    assert jtype2 == "continuous"
    assert damp2  == 1.5

    # 3. 十字轴插入十字孔 -> 不兼容圆孔 -> fixed
    axle     = get_interface("axle.dat")
    axlehole = get_interface("axlehole.dat")
    assert axle is not None and axlehole is not None
    fit3 = check_fit(axle, axlehole)
    jtype3, _, _ = derive_joint_params(axle, axlehole)
    print(f"[十字轴→十字孔]  配合={fit3.value}, 关节={jtype3}")
    assert fit3   == FitType.CLEARANCE
    assert jtype3 == "fixed"

    # 4. 十字轴插圆孔 -> 不兼容
    fit4 = check_fit(axle, hole)
    print(f"[十字轴→圆孔]    配合={fit4.value}")
    assert fit4 == FitType.INCOMPATIBLE

    # 5. build_fit_result 格式测试
    res = build_fit_result(pin, hole, "3749", "32524")
    print(f"[build_fit_result] can_insert={res['can_fully_insert']}, method={res['method']}")
    assert res["fit_type"] == "clearance"
    assert res["method"]   == "parametric"

    # 6. 过约束 -> fixed
    jtype6, _, _ = derive_joint_params(pin, hole, is_overconstrained=True)
    print(f"[过约束]         关节={jtype6}")
    assert jtype6 == "fixed"

    print("\n[所有断言通过 OK]")

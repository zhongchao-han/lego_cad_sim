import numpy as np
import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, Tuple

from backend.port_semantics import (
    ConnectionInterface, Gender, Profile, FitType,
    get_interface, check_fit, derive_joint_params,
)
from backend.core_constants import LDU

# 配置日志
logger = logging.getLogger(__name__)

@dataclass
class Port:
    """
    具有物理语义的强类型端口。
    """
    name: str
    interface: ConnectionInterface
    position: np.ndarray  # (3,) SI 米制
    rotation: np.ndarray  # (3,3) 归一化正交矩阵
    port_type: str = "peghole"
    part_context: Optional[str] = None

    @classmethod
    def from_raw(cls, name: str, ldraw_type: str, pos: np.ndarray, rot: np.ndarray, part_context: Optional[str] = None):
        """
        工厂方法: 将 LDraw 原始数据转换为归一化 Port。
        """
        interface = get_interface(ldraw_type)
        if not interface: return None
        return cls(name=name, interface=interface, position=pos, rotation=rot, port_type=ldraw_type, part_context=part_context)

    def to_dict(self) -> Dict:
        return {
            "name": self.name,
            "type": self.port_type,
            "position": self.position.tolist(),
            "rotation": self.rotation.tolist()
        }

    def test_fit_with(self, other: 'Port') -> FitType:
        return check_fit(self.interface, other.interface)

    def derive_joint(self, other: 'Port', is_merged: bool = False) -> Tuple[str, float, float]:
        return derive_joint_params(self.interface, other.interface, is_merged)

    def calculate_relative_transform(self, other: 'Port') -> np.ndarray:
        from backend.geometry_processor import calculate_p2p_alignment
        return calculate_p2p_alignment(self, other)

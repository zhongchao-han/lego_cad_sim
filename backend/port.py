import numpy as np
import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, Tuple, List

from backend.port_semantics import (
    ConnectionInterface, Profile, FitType,
    get_interface, check_fit, derive_joint_params,
)

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
    is_manually_adjusted: bool = False  # 是否经过人工微调
    part_context: Optional[str] = None

    @classmethod
    def from_raw(cls, name: str, ldraw_type: str, pos: np.ndarray, rot: np.ndarray, 
                 is_manually_adjusted: bool = False, part_context: Optional[str] = None):
        """
        工厂方法: 将 LDraw 原始数据转换为归一化 Port。
        """
        interface = get_interface(ldraw_type)
        if not interface:
            return None
        return cls(
            name=name, interface=interface, position=pos, rotation=rot, 
            port_type=ldraw_type, is_manually_adjusted=is_manually_adjusted, part_context=part_context
        )

    @classmethod
    def from_config(cls, *args, **kwargs):
        """[Alias] 语义别名，符合从 JSON 配置加载的语境"""
        return cls.from_raw(*args, **kwargs)

    def to_dict(self) -> Dict:
        return {
            "name": self.name,
            "type": self.port_type,
            "gender": self.interface.gender.value if self.interface else "UNKNOWN",
            "position": self.position.tolist(),
            "rotation": self.rotation.tolist(),
            "is_manually_adjusted": self.is_manually_adjusted
        }

    def test_fit_with(self, other: 'Port') -> FitType:
        return check_fit(self.interface, other.interface)

    def derive_joint(self, other: 'Port', is_merged: bool = False) -> Tuple[str, float, float]:
        return derive_joint_params(self.interface, other.interface, is_merged)

    def calculate_relative_transform(self, other: 'Port') -> np.ndarray:
        from backend.geometry_processor import calculate_p2p_alignment
        return calculate_p2p_alignment(self, other)

@dataclass
class Site:
    """
    Site 是共享同一中心点 (LDU Grid) 的 Port 逻辑集合。
    用于解决零件同轴/同心位置下不同形状 (Round/Cross) 的语义聚合。
    """
    id: str
    ports: List[Port] = field(default_factory=list)
    occupied_by: Optional[str] = None
    
    @property
    def position(self) -> np.ndarray:
        """返回该坑位的物理中心点坐标 (基于其拥有的首个 Port)"""
        if not self.ports:
            return np.zeros(3)
        return self.ports[0].position

    def add_port(self, port: Port):
        """添加一个属于该坑位的端口"""
        self.ports.append(port)

    def get_ports_by_profile(self, profile: Profile) -> List[Port]:
        """根据横截面形状获取对应的端口 (用于歧义消解)"""
        return [p for p in self.ports if p.interface.profile == profile]

    def is_occupied(self) -> bool:
        """坑位是否已被占用"""
        return self.occupied_by is not None

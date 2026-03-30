import numpy as np

from backend.port import Port


def _make_port(name: str, ptype: str, pos: list) -> dict:
    """构造 site_utils 可识别的原始端口字典。"""
    return {
        "name": name,
        "type": ptype,
        "position": pos,
        "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    }

def _build_port(name: str, ptype: str, pos: list) -> Port:
    """构造强类型 Port 对象。"""
    p = Port.from_raw(name, ptype, np.array(pos, dtype=float), np.eye(3))
    if p is None:
        raise ValueError(f"无法构造端口，类型 '{ptype}' 未在 port_semantics 中注册。")
    return p

def _make_site(part_id: str, port_type: str = "peghole.dat", site_index: int = 0) -> dict:
    """构造最基础的 Site 字典（用于测试输入）。"""
    return {
        "id": f"{part_id}_site{site_index}",
        "position": [0.0, 0.0, 0.0],
        "occupied_by": None,
        "ports": [
            {
                "name": f"{part_id}_p0",
                "type": port_type,
                "position": [0.0, 0.0, 0.0],
                "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "is_manually_adjusted": False,
            }
        ],
    }

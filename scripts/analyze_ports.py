import os
import sys
import logging
from typing import Dict, List, Optional, Any
import numpy as np

# 添加 backend 目录到 sys.path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'backend'))

from port_library import PortLibrary
from port_library_manager import PortLibraryManager
from math_utils import purify_rotation_matrix
from core_constants import HALF_GRID_LDU, LDU_TO_SI

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# 常量定义
SEMANTIC_PRIMITIVES = ["peghole.dat", "axlehole.dat", "pin.dat", "axle.dat", "halfpin.dat", "connect.dat"]
CONNECTOR_PREFIXES = ["confric", "axlehole", "peghole", "axle", "pin", "halfpin"]
KNOWN_UNIT_LENGTHS = {
    "confric3": 2.0, 
    "confric6": 2.0,
    "axlehol8.dat": 5.75
}

class PortDiscoverer:
    def __init__(self, ldraw_path: Optional[str] = None):
        if ldraw_path is None:
            self.ldraw_path = os.path.normpath(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ldraw_lib")))
        else:
            self.ldraw_path = ldraw_path
        self.manager = PortLibraryManager()

    def resolve_path(self, filename: str) -> Optional[str]:
        return PortLibrary.resolve_path(self.ldraw_path, filename)

    def _calculate_confidence(self, ports: List[Dict]) -> float:
        if not ports: return 0.0
        score = 1.0
        for p in ports:
            pos = np.array(p['position'])
            if any(abs(v % HALF_GRID_LDU) > 0.5 and abs(v % HALF_GRID_LDU) < 9.5 for v in pos):
                score *= 0.7
            if p['type'] not in SEMANTIC_PRIMITIVES and not any(pfx in p['type'] for pfx in CONNECTOR_PREFIXES):
                score *= 0.8
        return round(max(0.1, score), 2)

    def discover_ports(self, filename: str, transform: np.ndarray = np.eye(4)) -> List[Dict]:
        filepath = self.resolve_path(filename)
        if not filepath: return []
        
        discovered = []
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except:
            return []

        for line in lines:
            parts = line.strip().split()
            if not parts: continue
            
            if parts[0] == '1':
                if len(parts) >= 15:
                    child_file = parts[-1].lower()
                    try:
                        x, y, z = map(float, parts[2:5])
                        a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
                        local_mat = np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1]])
                        global_mat = transform @ local_mat
                        
                        y_scale = max(np.linalg.norm(local_mat[:3, 0]), np.linalg.norm(local_mat[:3, 1]), np.linalg.norm(local_mat[:3, 2]))
                        
                        child_basename = os.path.basename(child_file).split('.')[0]
                        is_semantic = any(p in child_file for p in SEMANTIC_PRIMITIVES)
                        is_connector = any(child_basename.startswith(pfx) for pfx in CONNECTOR_PREFIXES)

                        if is_semantic or is_connector:
                            base_unit_len = 1.0
                            for k, v in KNOWN_UNIT_LENGTHS.items():
                                if k in child_basename:
                                    base_unit_len = v; break
                            
                            length_ldu = y_scale * base_unit_len * 20.0 if y_scale <= 10.0 else y_scale
                            num_units = int(round(length_ldu / 20.0))
                            
                            if num_units >= 1:
                                # 核心修正：探测生长方向
                                # 在插销类原件中，LDraw 习惯向 -Y 方向生长 (0, -20, -40...)
                                is_pin_type = any(x in child_file for x in ["peg", "pin", "axle", "confric"])
                                step_dir = -1.0 if is_pin_type else 1.0
                                
                                for k in range(num_units):
                                    # 采样点在本地坐标系的偏移。
                                    # 第一孔位通常在 0，后续孔位按 20 LDU 步进
                                    offset_y = k * 20.0 * step_dir
                                    # 转换为本地单位缩放下的偏移值
                                    lv = np.array([0, offset_y / y_scale, 0, 1])
                                    sampled_pos = (global_mat @ lv)[:3]
                                    
                                    # --- 宏观数据流治理：使用统一数学中枢进行正交规范化与旋向纠偏 ---
                                    raw_rot = global_mat[:3, :3].copy()
                                    norm_rot = purify_rotation_matrix(raw_rot)
                                    
                                    from port import Port
                                    ld_type = "fric_pin.dat" if "fric" in child_file else ("peghole" if "hole" in child_file else "peg")
                                    
                                    port_obj = Port.from_raw(
                                        name=f"{filename}_p",
                                        ldraw_type=ld_type,
                                        pos=sampled_pos,
                                        rot=norm_rot,
                                        part_context=filename
                                    )
                                    if port_obj:
                                        discovered.append(port_obj.to_dict())
                    except:
                        continue
                else:
                    child_file = parts[-1].lower()
                    discovered.extend(self.discover_ports(child_file, transform=global_mat))
        return discovered

    def run_on_parts(self, part_list: List[str], force: bool = False):
        for part in part_list:
            logger.info(f"分析中: {part}")
            ports = self.discover_ports(part)
            unique = []
            if ports:
                for p in ports:
                    if not any(np.linalg.norm(np.array(p['position']) - np.array(u['position'])) < 0.5 for u in unique):
                        unique.append(p)
            logger.info(f"  -> 录入 {len(unique)} 端口")
            self.manager.update_part_config(part, unique, "pending", self._calculate_confidence(unique), force)
        self.manager.save()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("parts", nargs="*")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    parts_to_scan = args.parts if args.parts else ["6558.dat"]
    discoverer = PortDiscoverer()
    discoverer.run_on_parts(parts_to_scan, force=args.force)

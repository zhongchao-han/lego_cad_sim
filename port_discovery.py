import os
import json
import logging
from typing import Dict, List, Optional, Any
import numpy as np

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# 常量定义
SEMANTIC_PRIMITIVES = ["peghole.dat", "axlehole.dat", "pin.dat", "axle.dat", "halfpin.dat", "connect.dat"]
CONNECTOR_PREFIXES = ["confric", "axlehole", "peghole", "axle", "pin", "halfpin"]
KNOWN_UNIT_LENGTHS = {"confric6": 2.0, "confric3": 2.0, "confric2": 2.0}

class PortDiscoverer:
    """
    离线端口识别工具。
    目标：识别 100% 正确的数据并持久化到 json 配置文件中。
    """
    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.ldraw_path = ldraw_path
        self.results = {}
        self.config_path = "ldraw_port_configs.json"
        
        if os.path.exists(self.config_path):
            with open(self.config_path, 'r', encoding='utf-8') as f:
                self.results = json.load(f)

    def resolve_path(self, filename: str) -> Optional[str]:
        filename = filename.lower().replace('\\', '/')
        search_dirs = ["parts", "p", "parts/s", "p/48"]
        for d in search_dirs:
            p = os.path.join(self.ldraw_path, d, os.path.basename(filename))
            if os.path.exists(p): return p
        return None

    def discover_ports(self, filename: str, transform: np.ndarray = np.eye(4)) -> List[Dict]:
        """识别零件端口定义。"""
        filepath = self.resolve_path(filename)
        if not filepath: return []
        
        discovered = []
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except: return []

        for line in lines:
            parts = line.strip().split()
            if not parts or parts[0] != '1' or len(parts) < 15: continue
            
            child_file = parts[-1].lower()
            try:
                x, y, z = map(float, parts[2:5])
                a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
                local_mat = np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1]])
                global_mat = transform @ local_mat
                
                child_basename = os.path.basename(child_file).split('.')[0]
                is_semantic = any(p in child_file for p in SEMANTIC_PRIMITIVES)
                is_connector = any(child_basename.startswith(pfx) for pfx in CONNECTOR_PREFIXES)

                if is_semantic or is_connector:
                    y_scale = np.linalg.norm(local_mat[:3, 1])
                    base_unit_len = 1.0
                    for k, v in KNOWN_UNIT_LENGTHS.items():
                        if k in child_basename:
                            base_unit_len = v; break
                    
                    length_ldu = y_scale * base_unit_len * 20.0 if y_scale <= 10.0 else y_scale
                    
                    # 严格校验：步长必须接近 20 LDU 的整数倍
                    num_units_float = length_ldu / 20.0
                    if abs(num_units_float - round(num_units_float)) > 0.05:
                        logger.warning(f"跳过不确定原件: {filename} -> {child_file} (长度 {num_units_float:.2f}L 非标)")
                        continue
                    
                    num_units = int(round(num_units_float))
                    if num_units > 1:
                        start_phys_offset = -(num_units - 1) * 10.0
                        for k in range(num_units):
                            phys_offset_y = start_phys_offset + k * 20.0
                            local_offset_y = phys_offset_y / (y_scale * (base_unit_len if y_scale <= 10.0 else 1.0))
                            offset_vec = np.array([0, local_offset_y, 0, 1])
                            sampled_pos = (global_mat @ offset_vec)[:3]
                            discovered.append({
                                "type": "peg" if is_connector else child_file,
                                "position": [float(round(v, 4)) for v in sampled_pos],
                                "rotation": [[float(round(v, 4)) for v in row] for row in global_mat[:3, :3].tolist()]
                            })
                    else:
                        discovered.append({
                            "type": "peg" if is_connector else child_file,
                            "position": [float(round(v, 4)) for v in global_mat[:3, 3]],
                            "rotation": [[float(round(v, 4)) for v in row] for row in global_mat[:3, :3].tolist()]
                        })
                else:
                    # 递归寻找子部件
                    discovered.extend(self.discover_ports(child_file, transform=global_mat))
            except: continue
        return discovered

    def run_on_parts(self, part_list: List[str]):
        """运行识别并更新 JSON。"""
        for part in part_list:
            logger.info(f"正在分析: {part}")
            ports = self.discover_ports(part)
            if ports:
                # 简单位置去重
                unique = []
                for p in ports:
                    if not any(np.linalg.norm(np.array(p['position']) - np.array(u['position'])) < 0.5 for u in unique):
                        unique.append(p)
                self.results[part] = {"ports": unique}
                logger.info(f"  -> 识别到 {len(unique)} 个端口。")
            else:
                logger.error(f"  !! 未能自动识别端口: {part}")

        with open(self.config_path, 'w', encoding='utf-8') as f:
            json.dump(self.results, f, indent=2)
            logger.info(f"配置已写回 {self.config_path}")

if __name__ == "__main__":
    discoverer = PortDiscoverer()
    # 示例：分析 6558, 2780, 以及一个 6L 轴 3706
    discoverer.run_on_parts(["6558.dat", "2780.dat", "3706.dat", "32523.dat"])

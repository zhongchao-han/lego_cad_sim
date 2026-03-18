import os
import logging
from typing import Dict, List, Optional, Any
import numpy as np

from port_config_manager import PortConfigManager

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
    目标：识别 100% 正确的数据并通过 PortConfigManager 持久化。
    """
    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.ldraw_path = ldraw_path
        self.manager = PortConfigManager()

    def resolve_path(self, filename: str) -> Optional[str]:
        """定位 LDraw 文件路径。"""
        filename = filename.lower().replace('\\', '/')
        search_dirs = ["parts", "p", "parts/s", "p/48"]
        for d in search_dirs:
            p = os.path.join(self.ldraw_path, d, os.path.basename(filename))
            if os.path.exists(p): return p
        return None

    def _calculate_confidence(self, ports: List[Dict]) -> float:
        """简单的自信度启发式算法 (0.0 - 1.0)"""
        if not ports: return 0.0
        
        score = 1.0
        for p in ports:
            pos = np.array(p['position'])
            # 1. 格点校验：乐高通常在 20 LDU 格点或 10 LDU 半格点上
            # 允许 0.5 LDU 的误差 (0.2mm)
            if any(abs(v % 10.0) > 0.5 and abs(v % 10.0) < 9.5 for v in pos):
                score *= 0.7
            
            # 2. 类型校验：如果是不常用的原件类型
            if p['type'] not in SEMANTIC_PRIMITIVES and not any(pfx in p['type'] for pfx in CONNECTOR_PREFIXES):
                score *= 0.8
                
        return round(max(0.1, score), 2)

    def discover_ports(self, filename: str, transform: np.ndarray = np.eye(4)) -> List[Dict]:
        """递归识别零件端口定义。"""
        filepath = self.resolve_path(filename)
        if not filepath: return []
        
        discovered = []
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            logger.error(f"无法读取文件 {filepath}: {e}")
            return []

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
                        # 多单元采样（见 docs/issue/6558_insertion_depth_analysis.md）
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
            except Exception as e:
                logger.debug(f"解析行失败: {line.strip()} ({e})")
                continue
        return discovered

    def run_on_parts(self, part_list: List[str], force: bool = False):
        """运行识别并更新配置。"""
        for part in part_list:
            logger.info(f"正在分析: {part}")
            ports = self.discover_ports(part)
            
            if ports:
                # 简单位置去重
                unique = []
                for p in ports:
                    if not any(np.linalg.norm(np.array(p['position']) - np.array(u['position'])) < 0.5 for u in unique):
                        unique.append(p)
                
                confidence = self._calculate_confidence(unique)
                success = self.manager.update_part_config(
                    part_id=part,
                    ports=unique,
                    status="pending",
                    confidence=confidence,
                    force=force
                )
                if success:
                    logger.info(f"  -> 识别到 {len(unique)} 个端口 (自信度: {confidence})。")
            else:
                logger.error(f"  !! 未能自动识别端口: {part}")

        self.manager.save()

if __name__ == "__main__":
    import sys
    # 示例用法：python port_discovery.py 6558.dat 2780.dat
    parts_to_scan = sys.argv[1:] if len(sys.argv) > 1 else ["6558.dat", "2780.dat", "3706.dat", "32523.dat"]
    
    discoverer = PortDiscoverer()
    discoverer.run_on_parts(parts_to_scan)

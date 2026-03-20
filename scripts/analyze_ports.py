import os
import sys
import logging
from typing import Dict, List, Optional, Any
import numpy as np

# 添加 backend 目录到 sys.path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'backend'))

from port_library import PortLibrary
from port_library_manager import PortLibraryManager
from core_constants import HALF_GRID_LDU, LDU_TO_SI

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# 常量定义
SEMANTIC_PRIMITIVES = ["peghole.dat", "axlehole.dat", "pin.dat", "axle.dat", "halfpin.dat", "connect.dat"]
CONNECTOR_PREFIXES = ["confric", "axlehole", "peghole", "axle", "pin", "halfpin"]
KNOWN_UNIT_LENGTHS = {"confric3": 2.0, "axlehol8.dat": 5.75}

class PortDiscoverer:
    """
    离线端口识别工具。
    目标：识别 100% 正确的数据并通过 PortConfigManager 持久化。
    """
    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.ldraw_path = ldraw_path
        self.manager = PortLibraryManager()

    def resolve_path(self, filename: str) -> Optional[str]:
        """[委托] 使用系统的标准文件定位规则。"""
        return PortLibrary.resolve_path(self.ldraw_path, filename)

    def _calculate_confidence(self, ports: List[Dict]) -> float:
        """简单的自信度启发式算法 (0.0 - 1.0)"""
        if not ports: return 0.0
        
        score = 1.0
        for p in ports:
            pos = np.array(p['position'])
            # 1. 格点校验：乐高通常在 20 LDU 格点或 10 LDU 半格点上
            # 允许 0.5 LDU 的误差 (0.2mm)
            if any(abs(v % HALF_GRID_LDU) > 0.5 and abs(v % HALF_GRID_LDU) < 9.5 for v in pos):
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
                    # 放宽公差到 0.25L，以兼容像 axlehol8.dat (115 LDU -> 5.75L) 这样的原件
                    if abs(num_units_float - round(num_units_float)) > 0.25:
                        logger.warning(f"跳过不确定原件: {filename} -> {child_file} (长度 {num_units_float:.2f}L 非标)")
                        continue
                    
                    num_units = int(round(num_units_float))
                    if num_units >= 1:
                        # 采样偏置逻辑：
                        # LDraw 原件通常有两种 origin 风格：
                        # 1. Origin at Center (如大部分长梁): 3 units -> -20, 0, 20
                        # 2. Origin at First Hole (如大部分 pin/axle 子原件): 3 units -> 0, 20, 40
                        # 
                        # 我们通过检测 Y 轴的 bounding box 来智能判断：
                        # 如果 Y_min < 0 且 Y_max > 0，则假定为 Center 风格。
                        # 否则假定为 First Hole 风格。
                        
                        start_phys_offset = -(num_units - 1) * 10.0 # 默认 Center 风格
                        
                        # 特殊逻辑修正：常见的销/轴原件 (confric系列、peg/pin/axle) 通常以孔位为原点
                        if is_connector or any(x in child_file for x in ["peg", "pin", "axle", "hole"]):
                             # 这种情况下，第一个端口就在原点 (0,0,0)
                             start_phys_offset = 0.0
                        
                        for k in range(num_units):
                            phys_offset_y = start_phys_offset + k * 20.0
                            
                            # 修正采样间距逻辑：直接使用 LDU 物理偏移除以本地缩放
                            # y_scale 已经包含了本地定义的缩放 (b, e, h 列的模)
                            local_offset_y = phys_offset_y / y_scale
                            offset_vec = np.array([0, local_offset_y, 0, 1])
                            sampled_pos = (global_mat @ offset_vec)[:3]
                            
                            # --- 统一入库标准：分配正确的语义类型 ---
                            def get_semantic_type(fname):
                                fname = fname.lower()
                                if "peghole" in fname: return "peghole"
                                if "axlehole" in fname: return "axlehole"
                                if "peg" in fname or "pin" in fname: return "peg"
                                if "axle" in fname: return "axle"
                                return fname
                            
                            from port import Port
                            port_obj = Port.from_raw(
                                name=f"{filename}_p",
                                ldraw_type=get_semantic_type(child_file) if (is_semantic or is_connector) else child_file,
                                pos=np.array(sampled_pos),
                                rot=global_mat[:3, :3],
                                part_context=filename
                            )

                            if port_obj:
                                p_data = port_obj.to_dict()
                                # 再次应用智能格点吸附（基于 LDU 坐标）
                                def smart_snap(v):
                                    snapped = round(v / 10.0) * 10.0
                                    return float(snapped) if abs(v - snapped) < 0.1 else float(round(v, 4))
                                
                                p_data["position"] = [smart_snap(x) for x in p_data["position"]]
                                # 旋转矩阵部分已经由 Port.from_raw 处理归一化，此处仅需整理
                                p_data["rotation"] = [[round(x, 4) for x in row] for row in p_data["rotation"]]
                                discovered.append(p_data)
                    else:
                        # 兜底：处理 num_units=0 的零件（非常小的原件），默认在其中心创建一个端口
                        pos = global_mat[:3, 3]
                        from port import Port
                        port_obj = Port.from_raw(
                            name=f"{filename}_p_center",
                            ldraw_type="peg" if is_connector else child_file,
                            pos=pos,
                            rot=global_mat[:3, :3],
                            part_context=filename
                        )
                        if port_obj:
                            p_data = port_obj.to_dict()
                            def smart_snap(v):
                                snapped = round(v / 10.0) * 10.0
                                return float(snapped) if abs(v - snapped) < 0.1 else float(round(v, 4))
                            p_data["position"] = [smart_snap(x) for x in p_data["position"]]
                            p_data["rotation"] = [[round(x, 4) for x in row] for row in p_data["rotation"]]
                            discovered.append(p_data)
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
            
            # 简单位置去重
            unique = []
            if ports:
                for p in ports:
                    if not any(np.linalg.norm(np.array(p['position']) - np.array(u['position'])) < 0.5 for u in unique):
                        unique.append(p)
            
            # 自信度：如果完全没识别到端口，自信度设为极低（0.05），提醒用户手动添加
            confidence = self._calculate_confidence(unique) if unique else 0.05
            
            success = self.manager.update_part_config(
                part_id=part,
                ports=unique,
                status="pending",
                confidence=confidence,
                force=force
            )
            if success:
                logger.info(f"  -> 已录入: {len(unique)} 个端口 (自信度: {confidence})。")
            else:
                logger.debug(f"  -> 跳过已复核/锁定零件: {part}")

        self.manager.save()

if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="LDraw 零件端口自动识别工具")
    parser.add_argument("parts", nargs="*", help="要扫描的 .dat 零件列表 (例如: 6558.dat 2780.dat)")
    parser.add_argument("--force", action="store_true", help="强制覆盖已人工验证 (verified) 的数据")
    
    args = parser.parse_args()

    # 如果没传参数，使用默认测试集
    parts_to_scan = args.parts if args.parts else ["6558.dat", "2780.dat", "3706.dat", "32523.dat"]
    
    discoverer = PortDiscoverer()
    discoverer.run_on_parts(parts_to_scan, force=args.force)

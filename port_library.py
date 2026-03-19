import os
import json
import logging
from typing import Dict, List, Optional, Any
import numpy as np

from port import Port

# 配置日志记录
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

LDU_TO_SI = 0.0004

class PortLibrary:
    """
    端口语义库加载器。
    
    原则：100% 配置文件驱动。
    - 仅从 ldraw_port_configs.json 读取端口定义。
    - 该类作为系统唯一的“端口语义真理来源”，服务于仿真、渲染和复核。
    """
    
    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.ldraw_path = ldraw_path
        self.fallback_data: Dict[str, Any] = {}
        
        # 强制加载已校验的成品库
        config_path = os.path.join(os.path.dirname(__file__), "ldraw_port_configs.json")
        if os.path.exists(config_path):
            self.load_port_configs(config_path)
        else:
            logger.warning(f"未找到端口配置文件: {config_path}。系统将无法识别任何连接点。")
            
    def load_port_configs(self, filepath: str) -> None:
        """加载端口配置。"""
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                self.fallback_data = json.load(f)
                logger.debug(f"成功加载 {len(self.fallback_data)} 个零件的端口配置。")
        except Exception as e:
            logger.error(f"解析 JSON 配置出错 {filepath}: {e}")

    def parse_dat_file(self, filename: str, transform: np.ndarray = np.eye(4), allow_pending: bool = False) -> List[Port]:
        """
        从已校验端口库中提取零件端口。
        
        Args:
            filename: LDraw 文件名（如 '6558.dat'）。
            transform: 初始变换矩阵。
            allow_pending: 是否允许加载未验证 (pending) 的零件。
                           仿真引擎应设为 False (默认)，Library Verify UI 应设为 True。
        """
        filename = filename.strip().lower().replace('\\', '/')
        part_name = os.path.basename(filename)

        if part_name not in self.fallback_data:
            return []

        part_config = self.fallback_data[part_name]
        
        # 严格模式：除非显示允许，否则只加载已复核的零件
        if not allow_pending and part_config.get("status") != "verified":
            logger.debug(f"跳过未验证零件: {part_name}")
            return []

        json_ports = []
        for i, mp in enumerate(part_config.get("ports", [])):
            pos_ldu    = np.array(mp.get("position", [0.0, 0.0, 0.0]))
            # 应用传入的变换矩阵（主要处理子装配递归）
            pos_global = (transform @ np.append(pos_ldu, 1.0))[:3]
            
            # 重要：JSON 中的 rotation 已经是归一化后的成品，直接应用 transform 旋转部分
            rot_local  = np.array(mp.get("rotation", np.eye(3).tolist()))
            rot_global = transform[:3, :3] @ rot_local
            
            p_type     = mp.get("type", "peg")
            
            # 使用 from_config 工厂：直接信任数据，跳过二次变换，修复“箭头向下”Bug
            port = Port.from_config(
                f"{part_name}_p{i}", p_type, pos_global * LDU_TO_SI, rot_global
            )
            if port:
                json_ports.append(port)
                
        return json_ports

    def resolve_path(self, filename: str) -> Optional[str]:
        """寻找文件的绝对路径（供外部工具使用）。"""
        filename = filename.lower().replace('\\', '/')
        # 简单逻辑：假定在 parts 或 p 目录下
        for sub in ["parts", "p", "parts/s", "p/48"]:
            full_path = os.path.normpath(os.path.join(self.ldraw_path, sub, os.path.basename(filename)))
            if os.path.exists(full_path):
                return full_path
        return None

if __name__ == "__main__":
    library = PortLibrary()
    test_part = "6558.dat"
    ports = library.parse_dat_file(test_part)
    print(f"运行时：零件 {test_part} 载入 {len(ports)} 个端口。")

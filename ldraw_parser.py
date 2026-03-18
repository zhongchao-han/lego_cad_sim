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

class LDrawParser:
    """
    精简版运行时解析器。
    
    原则：100% 配置文件驱动。
    - 仅从 ldraw_port_configs.json 读取端口定义。
    - 不在运行时进行任何复杂的启发式识别，确保行为确定性。
    """
    
    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.ldraw_path = ldraw_path
        self.fallback_data: Dict[str, Any] = {}
        
        # 强制加载手工配置/自动识别后的结果库
        config_path = os.path.join(os.path.dirname(__file__), "ldraw_port_configs.json")
        if os.path.exists(config_path):
            self.load_port_configs(config_path)
        else:
            logger.warning(f"未找到端口配置文件: {config_path}。请运行 python port_discovery.py 生成配置。")

    def load_port_configs(self, filepath: str) -> None:
        """加载端口配置。"""
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                self.fallback_data = json.load(f)
                logger.info(f"成功加载 {len(self.fallback_data)} 个零件的端口配置。")
        except Exception as e:
            logger.error(f"解析 JSON 配置出错 {filepath}: {e}")

    def parse_dat_file(self, filename: str, transform: np.ndarray = np.eye(4)) -> List[Port]:
        """
        根据配置文件获取零件端口。
        """
        filename = filename.strip().lower().replace('\\', '/')
        part_name = os.path.basename(filename)

        if part_name not in self.fallback_data:
            # 如果是未定义的科技件或含有连接语义的零件，在此处可以给出一个弱警告
            # logger.debug(f"零件 {part_name} 未在配置中定义端口。")
            return []

        json_ports = []
        part_config = self.fallback_data[part_name]
        
        for i, mp in enumerate(part_config.get("ports", [])):
            pos_ldu    = np.array(mp.get("position", [0.0, 0.0, 0.0]))
            # 应用传入的变换矩阵（用于递归解析子装配，虽然现在运行时基本不递归了）
            pos_global = (transform @ np.append(pos_ldu, 1.0))[:3]
            
            rot_local  = np.array(mp.get("rotation", np.eye(3).tolist()))
            rot_global = transform[:3, :3] @ rot_local
            
            p_type     = mp.get("type", "peg")
            port = Port.create_from_ldraw(
                f"{part_name}_p{i}", p_type, pos_global * LDU_TO_SI, rot_global,
                part_context=part_name
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
    parser = LDrawParser()
    test_part = "6558.dat"
    ports = parser.parse_dat_file(test_part)
    print(f"运行时：零件 {test_part} 载入 {len(ports)} 个端口。")

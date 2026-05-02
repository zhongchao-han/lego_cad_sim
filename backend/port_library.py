import os
import json
import logging
from typing import Dict, List, Optional, Any
import numpy as np

from backend.port import Port

# 配置日志记录
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

class PortLibrary:
    """
    端口语义库加载器与文件解析器。
    
    原则：100% 配置文件驱动。
    - 仅从 ldraw_port_configs.json 读取端口定义。
    - 该类作为系统唯一的“端口语义真理来源”，服务于仿真、渲染和复核。
    - 同时也封装了 LDraw 库的标准文件搜索逻辑。
    """
    
    def __init__(self, ldraw_path: str = "ldraw_lib", data_store: Dict[str, Any] = None):
        self.ldraw_path = ldraw_path
        
        if data_store is not None:
            # 依赖注入：使用外部传入的数据源（如来自 PortLibraryManager 的引用）
            self._data = data_store
            logger.info("PortLibrary 已联结至共享内存数据源。")
        else:
            self._data = {}
            # 强制加载项目顶层 data/ 目录下的真理库
            config_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data", "ldraw_port_configs.json"))
            if os.path.exists(config_path):
                self.load_configs(config_path)
            else:
                logger.warning(f"未找到端口配置文件: {config_path}。系统将无法识别任何连接点。")
            
    def load_configs(self, filepath: str) -> None:
        """加载已复核的端口快照。"""
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                self._data = json.load(f)
                logger.debug(f"成功加载 {len(self._data)} 个零件的端口配置。")
        except Exception as e:
            logger.error(f"解析 JSON 配置出错 {filepath}: {e}")

    @staticmethod
    def resolve_path(ldraw_root: str, filename: str) -> Optional[str]:
        """
        [全系统通用] 根据 LDraw 标准库规则寻找文件的物理绝对路径。
        
        搜索优先级：
        1. 直接拼接根目录
        2. parts/
        3. p/
        4. parts/s/ (子原件)
        5. p/48/ (高精原件)
        """
        filename = filename.lower().replace('\\', '/')
        file_basename = os.path.basename(filename)

        # 候选根目录
        search_roots = [
            ldraw_root,
            os.path.join(ldraw_root, "parts"),
            os.path.join(ldraw_root, "p"),
            os.path.join(ldraw_root, "parts", "s"),
            os.path.join(ldraw_root, "p", "48")
        ]

        for root in search_roots:
            p = os.path.normpath(os.path.join(root, file_basename))
            if os.path.exists(p):
                return p
        
        # 兜底：尝试全路径匹配（如果 filename 包含了 parts/xxx 等）
        fallback = os.path.normpath(os.path.join(ldraw_root, filename))
        if os.path.exists(fallback):
            return fallback

        return None

    def parse_dat_file(self, filename: str, transform: np.ndarray = np.eye(4), allow_pending: bool = False) -> List[Port]:
        """
        从已校验端口库中提取零件端口。
        
        Args:
            filename: LDraw 文件名（如 '6558.dat'）。
            transform: 初始变换矩阵。
            allow_pending: 是否允许加载未验证 (pending) 的零件。
        """
        filename = filename.strip().lower().replace('\\', '/')
        part_name = os.path.basename(filename)

        if part_name not in self._data:
            return []

        part_config = self._data[part_name]
        
        # 严格过滤：仿真引擎应过滤掉所有 pending 零件
        if not allow_pending and part_config.get("status") != "verified":
            logger.debug(f"严格模式：跳过未经验证的零件 {part_name}")
            return []

        json_ports = []
        
        # 1. 优先加载 Site-Based 结构 (v3.1+)
        if "sites" in part_config:
            for site_idx, site_cfg in enumerate(part_config["sites"]):
                site_pos = np.array(site_cfg.get("position", [0.0, 0.0, 0.0]))
                for port_idx, mp in enumerate(site_cfg.get("ports", [])):
                    # 如果 Port 自身没有 position，则取 Site 的 position
                    p_pos_local = np.array(mp.get("position", site_pos))
                    pos_global = (transform @ np.append(p_pos_local, 1.0))[:3]
                    
                    rot_local  = np.array(mp.get("rotation", np.eye(3).tolist()))
                    rot_global = transform[:3, :3] @ rot_local
                    
                    p_type = mp.get("type", "peg")
                    is_adj = mp.get("is_manually_adjusted", False)
                    
                    port = Port.from_config(
                        f"{part_name}_s{site_idx}_p{port_idx}", p_type, pos_global, rot_global,
                        is_manually_adjusted=is_adj
                    )
                    if port:
                        json_ports.append(port)
                        
        # 2. 兜底加载扁平 Ports 结构 (向后兼容 v3.0)
        elif "ports" in part_config:
            for i, mp in enumerate(part_config["ports"]):
                pos_ldu    = np.array(mp.get("position", [0.0, 0.0, 0.0]))
                pos_global = (transform @ np.append(pos_ldu, 1.0))[:3]
                
                rot_local  = np.array(mp.get("rotation", np.eye(3).tolist()))
                rot_global = transform[:3, :3] @ rot_local
                
                p_type     = mp.get("type", "peg")
                is_adj     = mp.get("is_manually_adjusted", False)
                
                port = Port.from_config(
                    f"{part_name}_p{i}", p_type, pos_global, rot_global,
                    is_manually_adjusted=is_adj
                )
                if port:
                    json_ports.append(port)
                    
        return json_ports

if __name__ == "__main__":
    library = PortLibrary()
    test_part = "6558.dat"
    ports = library.parse_dat_file(test_part)
    print(f"运行时测试：零件 {test_part} 在 LDU 比例下载入 {len(ports)} 个端口。")

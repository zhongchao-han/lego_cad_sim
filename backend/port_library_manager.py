"""
port_config_manager.py
======================
负责零件端口配置 (ldraw_port_configs.json) 的统一存取与管理。
遵循单一责任原则 (SRP)，封装了“元数据锁”逻辑。
"""

import os
import json
import logging
import threading
from typing import Dict, List, Any, Optional

logger = logging.getLogger(__name__)

class PortLibraryManager:
    """
    管理 ldraw_port_configs.json 的持久化层。
    
    规则：
    1. verified 状态的数据默认禁止覆盖。
    2. 提供线程安全的读写操作。
    """
    
    def __init__(self, config_path: str = None):
        if config_path is None:
            # 默认指向项目顶层的 data/ 目录
            config_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data", "ldraw_port_configs.json"))
        self.config_path = config_path
        self._lock = threading.Lock()
        self._data: Dict[str, Any] = {}
        self.load()

    def load(self) -> None:
        """加载配置文件。若文件不存在则初始化为空。"""
        logger.debug(f"[DEBUG] 进入 load: path={self.config_path}")
        with self._lock:
            if not os.path.exists(self.config_path):
                logger.info(f"配置文件不存在，初始化新配置: {self.config_path}")
                self._data = {}
                return

            try:
                with open(self.config_path, 'r', encoding='utf-8') as f:
                    self._data = json.load(f)
                    logger.info(f"成功加载 {len(self._data)} 个零件配置。")
            except Exception as e:
                logger.error(f"加载配置文件失败: {e}", exc_info=True)
                raise RuntimeError(f"无法读取端口配置文件: {self.config_path}") from e

    def save(self) -> None:
        """持久化数据到文件。"""
        logger.debug(f"[DEBUG] 进入 save: path={self.config_path}")
        with self._lock:
            # [TRACER] 断点审计数据真理性
            _p = os.path.abspath(self.config_path)
            _s = self._data.get("6558.dat", {}).get("status", "N/A")
            print(f"[TRACE] Manager 准备落盘: Path={_p}, 6558 Status={_s}")
            
            temp_path = f"{self.config_path}.tmp"
            try:
                # 写入临时文件
                with open(temp_path, 'w', encoding='utf-8') as f:
                    json.dump(self._data, f, indent=2, ensure_ascii=False)
                
                # 在 Windows 上，原子性地替换文件
                # 使用 os.replace 替代 os.remove + os.rename
                os.replace(temp_path, self.config_path)
                logger.info(f"配置已保存至 {self.config_path}")
            except Exception as e:
                if os.path.exists(temp_path):
                    try: os.remove(temp_path)
                    except: pass
                logger.error(f"保存配置文件失败: {e}", exc_info=True)
                raise IOError(f"无法写入端口配置文件: {self.config_path}") from e

    def get_part_data(self, part_id: str) -> Optional[Dict[str, Any]]:
        """获取零件的完整元数据包副本。"""
        # 强制归一化 ID
        part_id = part_id.lower().replace(".dat", "") + ".dat"
        with self._lock:
            config = self._data.get(part_id)
            return json.loads(json.dumps(config)) if config else None

    def update_part(self, part_id: str, data: Dict[str, Any], force: bool = False) -> bool:
        """
        全量更新或合并更新零件的元数据。
        
        Args:
            part_id: 零件 ID (如 '32316.dat')
            data: 要写入的完整字典数据
            force: 是否强制覆盖 verified 状态的数据
        """
        logger.debug(f"[DEBUG] 进入 update_part: part_id={part_id}, force={force}")
        # 强制归一化 ID
        part_id = part_id.lower().replace(".dat", "") + ".dat"
        
        with self._lock:
            existing = self._data.get(part_id, {})
            if existing.get("verified", False) and not force:
                logger.warning(f"跳过更新: 零件 {part_id} 已人工核验 (verified)，且未启用 force。")
                return False

            # 将新数据深度写入主字典
            self._data[part_id] = data
            return True

    def get_part_config(self, part_id: str) -> Optional[Dict[str, Any]]:
        """兼容性包装器：等同于 get_part_data"""
        logger.debug(f"[DEBUG] 进入 get_part_config: part_id={part_id}")
        return self.get_part_data(part_id)

    def update_part_config(self, part_id: str, ports: List[Dict], status: str, confidence: float = 1.0, force: bool = False) -> bool:
        """
        [Compatibility] 专门服务于前端复核提交的接口。
        将复核后的坐标与状态打包更新入库，同时保留原有的 v3.0 元数据。
        """
        logger.debug(f"[DEBUG] 进入 update_part_config: part_id={part_id}, status={status}, force={force}")
        existing = self.get_part_data(part_id) or {}
        new_payload = existing.copy()
        
        # 应用复核后的核心数据
        new_payload.update({
            "ports": ports,
            "status": status,
            "confidence": confidence,
            "verified": (status == "verified")
        })
        
        return self.update_part(part_id, new_payload, force=force)

    def get_pending_parts(self) -> List[Dict[str, Any]]:
        """获取所有待复核的零件，按自信度升序排列（分值越低越靠前）。"""
        with self._lock:
            pending = []
            for pid, cfg in self._data.items():
                if cfg.get("status") == "pending":
                    pending.append({
                        "part_id": pid,
                        "confidence": cfg.get("confidence", 1.0),
                        "port_count": len(cfg.get("ports", []))
                    })
            
            # 自信度从小到大排序
            return sorted(pending, key=lambda x: x["confidence"])

    def get_verified_parts(self) -> List[Dict[str, Any]]:
        """获取所有已复核的零件摘要，用于物料库展示。"""
        with self._lock:
            verified = []
            for pid, cfg in self._data.items():
                if cfg.get("status") == "verified":
                    verified.append({
                        "part_id": pid,
                        "port_count": len(cfg.get("ports", [])),
                        # 默认颜色设为灰黑色 (color=7) 的 GLB 路径
                        "mesh_url": f"/ldraw_meshes/{pid.replace('.dat', '')}_c7.glb"
                    })
            return sorted(verified, key=lambda x: x["part_id"])

    def delete_part(self, part_id: str) -> bool:
        """删除某个零件的配置。"""
        with self._lock:
            if part_id in self._data:
                del self._data[part_id]
                return True
            return False

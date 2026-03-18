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

class PortConfigManager:
    """
    管理 ldraw_port_configs.json 的持久化层。
    
    规则：
    1. verified 状态的数据默认禁止覆盖。
    2. 提供线程安全的读写操作。
    """
    
    def __init__(self, config_path: str = "ldraw_port_configs.json"):
        self.config_path = config_path
        self._lock = threading.Lock()
        self._data: Dict[str, Any] = {}
        self.load()

    def load(self) -> None:
        """加载配置文件。若文件不存在则初始化为空。"""
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
        with self._lock:
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

    def get_part_config(self, part_id: str) -> Optional[Dict[str, Any]]:
        """获取特定零件的配置副本。"""
        with self._lock:
            config = self._data.get(part_id)
            return json.loads(json.dumps(config)) if config else None

    def update_part_config(self, part_id: str, ports: List[Dict[str, Any]], 
                           status: str = "pending", confidence: float = 1.0,
                           force: bool = False) -> bool:
        """
        更新零件配置。
        
        Args:
            part_id: 零件 ID (如 '6558.dat')
            ports: 端口列表
            status: 'pending' 或 'verified'
            confidence: 自信度 (0.0-1.0)
            force: 是否强制覆盖 verified 状态的数据
            
        Returns:
            bool: 是否成功更新。若因 verified 锁定且未开启 force，则返回 False。
        """
        with self._lock:
            existing = self._data.get(part_id, {})
            if existing.get("status") == "verified" and not force:
                logger.warning(f"跳过更新: 零件 {part_id} 已人工复核 (verified)，且未启用 force。")
                return False

            self._data[part_id] = {
                "status": status,
                "confidence": round(float(confidence), 2),
                "ports": ports
            }
            return True

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

    def delete_part(self, part_id: str) -> bool:
        """删除某个零件的配置。"""
        with self._lock:
            if part_id in self._data:
                del self._data[part_id]
                return True
            return False

import os
import sys
import json
import logging
import time
from typing import List, Dict, Any

# 确保加载 backend 模块
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.geometry_processor import GeometryProcessor
from backend.port_library_manager import PortLibraryManager

# 配置日志
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class UnifiedAssetBaker:
    """
    [v3.0 离线流水线] 统一资产烘焙器。
    它保证了零件的 GLB (几何网格) 与 JSON (端口配置) 始终保持同步。
    """

    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.gp = GeometryProcessor(ldraw_path=ldraw_path)
        self.plm = PortLibraryManager()
        from backend.mesh_asset_manager import MeshAssetManager
        self.asset_manager = MeshAssetManager()

    def bake_part(self, part_id: str, force: bool = False) -> bool:
        """
        原子操作：同时生成网格并刷新端口数据。
        """
        logger.debug(f"[DEBUG] 开始烘焙单个零件: part_id={part_id}, force={force}")
        # 统一规范：确保 part_id 包含 .dat 后缀
        if not part_id.lower().endswith(".dat"):
            part_id += ".dat"

        mesh_url = self.asset_manager.ensure_mesh_exists(
            part_id=part_id,
            color_code=7,
            geo_processor=self.gp
        )
        # 获取最终的绝对物理路径，以便写入 metadata 进行管理
        glb_path = self.asset_manager.get_absolute_glb_path(part_id, 7)
        
        # 1. 检查是否需要更新 (如果非强制且已验证，跳过)
        existing_data = self.plm.get_part_data(part_id)
        if not force and existing_data and existing_data.get("verified", False):
            logger.info(f"[-] 跳过已验证零件: {part_id}")
            return True

        logger.info(f"[*] 正在烘焙资产: {part_id} ...")
        
        try:
            # 2. 生成 GLB (视觉与物理碰撞)
            # 使用默认颜色 7 (浅灰)
            success_glb = self.gp.convert_to_glb(part_id, glb_path)
            if not success_glb:
                logger.error(f"[!] {part_id} GLB 转换失败。")
                return False

            # 3. 提取归一化端口配置 (JSON 数据) 与精确物理包围盒
            ports = self.gp.discover_ports(part_id)
            bounding_box = self.gp.compute_bounding_box(glb_path)
            
            # 4. 原子更新配置管理器
            # 记录烘焙元数据
            metadata = {
                "ports": ports,
                "glb_path": glb_path,
                "baked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "version": "v3.0.normalized"
            }
            if bounding_box:
                metadata["bounding_box"] = bounding_box

            self.plm.update_part(part_id, metadata)
            self.plm.save()
            
            logger.info(f"[OK] {part_id} 烘焙完成。")
            return True

        except Exception as e:
            logger.error(f"[FATAL] 烘焙零件 {part_id} 时崩溃: {e}")
            return False

    def bake_library(self, force: bool = False):
        """
        全量烘焙：对 ldraw_port_configs.json 中登记的所有零件执行同步更新。
        """
        logger.debug(f"[DEBUG] 开始全量库烘焙流程: force={force}")
        parts_list = list(self.plm._data.keys())
        logger.info(f"[INIT] 开始全量烘焙，目标总数: {len(parts_list)}")
        
        count = 0
        for pid in parts_list:
            if self.bake_part(pid, force=force):
                count += 1
        
        logger.info(f"[FINISH] 全量烘焙结束。成功: {count}/{len(parts_list)}")

if __name__ == "__main__":
    baker = UnifiedAssetBaker()
    
    # 支持命令行参数: 如果有参数则烘焙单个，否则全量烘焙
    if len(sys.argv) > 1:
        target = sys.argv[1]
        baker.bake_part(target, force=True)
    else:
        # 批量操作示例：只在此处启用 force 即可重刷整个库
        baker.bake_library(force=False)

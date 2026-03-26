import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)

class MeshAssetManager:
    """
    负责管理 3D 网格文件资产（如 GLB）的单例门面。
    彻底隔离 HTTP 路由层、批处理脚本与本地文件系统的耦合。
    确保系统所有脚本输出路径一致。
    """
    def __init__(self, cache_root: str = None):
        if cache_root is None:
            # 默认：始终相对于工程的 data/custom_assets 进行挂载
            self.mesh_cache_root = os.path.abspath(os.path.join(os.getcwd(), "data", "custom_assets"))
        else:
            self.mesh_cache_root = os.path.abspath(cache_root)
            
        os.makedirs(self.mesh_cache_root, exist_ok=True)
        self.url_mount_point = "/ldraw_meshes"

    def _get_default_glb_filename(self, part_id: str, color_code: int) -> str:
        """根据 LDraw part_id 约定，计算其默认相对路径（保留目录层级结构，如 s/xxx）。"""
        part_id = part_id.strip()
        # 统一去除 .dat 后缀以拼接 _c{color}
        if part_id.lower().endswith(".dat"):
            base = part_id[:-4]
        else:
            base = part_id
        # 为了防范类似 '39369 ' 被替换出带空格的 filename：
        base = base.replace(" ", "")
        
        return f"{base}_c{color_code}.glb"

    def get_absolute_glb_path(self, part_id: str, color_code: int, cached_glb_path: Optional[str] = None) -> str:
        """
        根据给定的零件 ID 和 缓存路径记录，计算其最终的本地绝对物理路径。
        """
        raw_path = cached_glb_path or self._get_default_glb_filename(part_id, color_code)
        
        if os.path.isabs(raw_path):
            return raw_path
        return os.path.join(self.mesh_cache_root, raw_path)

    def _compute_mesh_url(self, abs_path: str) -> str:
        """根据绝对路径计算相对于前端的 URL 路径。"""
        try:
            # os.path.relpath 在跨驱动器（Windows）时抛出 ValueError，此时降级策略：返回最末端文件名
            rel_path = os.path.relpath(abs_path, self.mesh_cache_root)
            rel_path = rel_path.replace("\\", "/") # 必须强制将 Windows 斜杠转换为 URL 斜杠的标准化
            
            # 如果 relpath 指出该文件竟爬出了 cache_root (防呆设计保障 SRP)
            if rel_path.startswith(".."):
               logger.warning(f"[MeshAssetManager] {abs_path} 的相对路径跳出了资源根目录, 降级截取 basename。")
               rel_path = os.path.basename(abs_path)
        except ValueError:
            rel_path = os.path.basename(abs_path)
            
        return f"{self.url_mount_point}/{rel_path}"

    def ensure_mesh_exists(self, part_id: str, color_code: int, geo_processor, cached_glb_path: Optional[str] = None) -> str:
        """
        门面方法：返回供前端请求的 mesh_url。
        如果文件在本地物理路径上丢失或从未被生成，将会利用注入的 GeometryProcessor 当场烘培。
        
        :param part_id: LDraw 文件标识（如 3001.dat 或 s/3001s01.dat）
        :param color_code: LDraw 颜色编码
        :param geo_processor: 用于转换/烘培 GLB 的服务（按需依赖注入）
        :param cached_glb_path: 来自持久化层的缓存路径覆盖
        :return: String URL，例如 '/ldraw_meshes/3001_c7.glb'
        """
        abs_path = self.get_absolute_glb_path(part_id, color_code, cached_glb_path)
        
        if not os.path.exists(abs_path):
            logger.info(f"[MeshAssetManager] GLB 文件未命中物理缓存: {abs_path}，正在委托烘焙...")
            try:
                os.makedirs(os.path.dirname(abs_path), exist_ok=True)
                # Ensure .dat extension is present for processor
                dat_filename = part_id if part_id.lower().endswith(".dat") else f"{part_id}.dat"
                geo_processor.convert_to_glb(dat_filename, abs_path, color_code=color_code)
            except Exception as e:
                logger.error(f"[MeshAssetManager] 实时生成 GLB 失败 -> {e}")
                
        return self._compute_mesh_url(abs_path)

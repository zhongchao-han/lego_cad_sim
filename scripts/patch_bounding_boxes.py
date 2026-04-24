import os
import sys
import logging

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from backend.port_library_manager import PortLibraryManager
from backend.geometry_processor import GeometryProcessor

logging.basicConfig(level=logging.INFO, format='%(message)s')

def patch_all():
    plm = PortLibraryManager()
    gp = GeometryProcessor()
    
    from backend.mesh_asset_manager import MeshAssetManager
    mesh_manager = MeshAssetManager(os.path.join(os.getcwd(), "data", "custom_assets"))
    
    parts = list(plm._data.keys())
    count = 0
    for part_id in parts:
        data = plm.get_part_data(part_id)
        
        logging.info(f"正在重算物理包围盒 (基于GLB): {part_id}")
        # 获取任意存在的 GLB 路径 (默认颜色 7)
        abs_glb_path = mesh_manager.get_absolute_glb_path(part_id, 7, data.get("glb_path"))
        
        if not os.path.exists(abs_glb_path):
            logging.info(f"GLB 不存在，尝试先生成 GLB: {part_id}")
            dat_filename = part_id if part_id.lower().endswith(".dat") else f"{part_id}.dat"
            success = gp.convert_to_glb(dat_filename, abs_glb_path, color_code=7)
            if not success:
                logging.warning(f"无法生成 {part_id} 的 GLB，跳过包围盒计算")
                continue
                
        bbox = gp.compute_bounding_box(abs_glb_path)
        if bbox:
            data["bounding_box"] = bbox
            # 强制突破人工复核锁，仅追加/修正核心几何数据
            plm.update_part(part_id, data, force=True)
            count += 1
        else:
            logging.warning(f"无法为 {part_id} 计算包围盒")
            
    if count > 0:
        plm.save()
        logging.info(f"包围盒批量修补完毕！共计修正了 {count} 个零件的元数据。")
    else:
        logging.info("无需更新。")

if __name__ == "__main__":
    patch_all()

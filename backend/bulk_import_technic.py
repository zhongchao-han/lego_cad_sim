import os
import sys
import logging
from concurrent.futures import ProcessPoolExecutor

# 添加 backend 到路径以便导入
sys.path.append(os.path.dirname(__file__))

from port_discovery import PortDiscoverer
from port_library_manager import PortLibraryManager

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# 科技件识别原性（凡是包含这些子部件的都被认为是科技件）
TECHNIC_PRIMITIVES = {
    "peghole.dat", "axlehole.dat", "pin.dat", "axle.dat", "halfpin.dat", 
    "connect.dat", "bush.dat", "m-axle.dat", "peg.dat"
}

def is_technic_part(filepath: str) -> bool:
    """通过扫描文件内容判断是否包含科技接口原语。"""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) > 14 and parts[0] == '1':
                    child = parts[-1].lower()
                    if any(p in child for p in TECHNIC_PRIMITIVES):
                        return True
    except:
        pass
    return False

def bulk_import_technic(ldraw_root: str):
    parts_dir = os.path.join(ldraw_root, "parts")
    if not os.path.exists(parts_dir):
        logger.error(f"未找到 parts 目录: {parts_dir}")
        return

    logger.info("正在扫描 LDraw 库以确定科技件列表...")
    technic_parts = []
    all_files = [f for f in os.listdir(parts_dir) if f.lower().endswith('.dat')]
    
    for f in all_files:
        if is_technic_part(os.path.join(parts_dir, f)):
            technic_parts.append(f)
    
    logger.info(f"扫描完成，找到 {len(technic_parts)} 个疑似科技件。")
    
    # 获取当前已有的库，避免重复扫描已验证或已存在的
    manager = PortLibraryManager()
    existing_parts = set(manager._data.keys())
    
    # 过滤掉已经存在的（除非你想重新扫描，这里我们只补全缺失的）
    to_scan = [p for p in technic_parts if p not in existing_parts]
    logger.info(f"其中 {len(to_scan)} 个为新零件，准备执行自动识别...")

    # 分批执行以避免单次运行过长
    batch_size = 50
    discoverer = PortDiscoverer(ldraw_path=ldraw_root)
    
    for i in range(0, len(to_scan), batch_size):
        batch = to_scan[i:i+batch_size]
        logger.info(f"正在处理批次 {i//batch_size + 1}/{(len(to_scan)-1)//batch_size + 1}...")
        discoverer.run_on_parts(batch)
        
    logger.info("全量科技件导入任务完成。")

if __name__ == "__main__":
    # 假设从项目根目录运行
    ldraw_root = "ldraw_lib"
    bulk_import_technic(ldraw_root)

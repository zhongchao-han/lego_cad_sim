import os
import sys
import logging
from concurrent.futures import ProcessPoolExecutor

# 添加 backend 到路径以便导入
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'backend'))
# 添加当前目录 (scripts) 到路径以导入 port_discovery
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

def is_technic_part(filename: str, filepath: str) -> bool:
    """综合通过文件名和文件内容判断是否包含科技接口。"""
    fname = filename.lower()
    # 极致全量关键词，确保全领域覆盖
    keywords = {
        "beam", "technic", "axle", "pin", "gear", "joint", "conn", "link", "peg", "hole", "liftarm", "panel",
        "pulley", "tire", "rim", "wheel", "pneumatic", "cylinder", "shock", "spring", "suspension", "steering"
    }
    if any(k in fname for k in keywords):
        return True

    # 只要包含了核心机械孔位原部件，或者描述中带科技件关键词就算
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            for i, line in enumerate(f):
                line_lower = line.lower()
                # 检查内容是否包含核心原部件
                if 'peghole' in line_lower or 'axlehole' in line_lower or 'pin.dat' in line_lower or 'axle.dat' in line_lower:
                    return True
                
                # 检查文件前 10 行是否包含科技件关键字 (通常是描述行)
                if i < 10 and any(k in line_lower for k in keywords):
                    return True
                
                if i > 100: break # 不扫太深，性能优先
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
    # 扫描 parts/ 和 parts/s/ (子原件)
    for root, _, files in os.walk(parts_dir):
        for f in files:
            if f.lower().endswith('.dat'):
                rel_path = os.path.relpath(os.path.join(root, f), parts_dir)
                if is_technic_part(f, os.path.join(root, f)):
                    technic_parts.append(rel_path)
    
    logger.info(f"扫描完成，找到 {len(technic_parts)} 个疑似科技件。")
    
    # 建立识别器
    discoverer = PortDiscoverer(ldraw_path=ldraw_root)
    
    # 获取当前管理器（内部已有跳过 verified 的逻辑）
    logger.info(f"正在对 {len(technic_parts)} 个零件执行自动识别与入库...")

    # 分批执行
    batch_size = 50
    for i in range(0, len(technic_parts), batch_size):
        batch = technic_parts[i:i+batch_size]
        logger.info(f"正在处理批次 {i//batch_size + 1}/{(len(technic_parts)-1)//batch_size + 1}...")
        discoverer.run_on_parts(batch)
        
    logger.info("全量科技件入库同步完成。")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="全量 LDraw 科技件端口自动识别与入库工具")
    parser.add_argument("--ldraw_root", type=str, default="ldraw_lib", help="LDraw 库根目录 (默认: ldraw_lib)")
    
    args = parser.parse_args()
    
    bulk_import_technic(args.ldraw_root)

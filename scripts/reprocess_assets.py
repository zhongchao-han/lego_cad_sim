import os
import sys
import argparse
import json

# 设置路径
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'backend'))

from geometry_processor import GeometryProcessor
from port_library_manager import PortLibraryManager

def main():
    parser = argparse.ArgumentParser(description="综合资产处理器：生成网格并解析端口")
    parser.add_argument("filenames", nargs="+", help="LDraw 文件名")
    parser.add_argument("--force", action="store_true", help="强制覆盖")
    args = parser.parse_args()

    proc = GeometryProcessor()
    lib_manager = PortLibraryManager()

    for filename in args.filenames:
        if not filename.lower().endswith(".dat"): filename += ".dat"
        
        # 1. 导出网格 (自动执行 Y-Up 归一化)
        mesh_out = os.path.join(os.getcwd(), "frontend", "public", "ldraw_meshes", f"{filename[:-4]}_c7.glb")
        if not os.path.exists(mesh_out) or args.force:
            print(f"[>] 正在生成归一化网格: {filename}...")
            proc.convert_to_glb(filename, mesh_out)
        
        # 2. 发现端口 (自动执行相同的归一化)
        print(f"[>] 正在提取物理端口: {filename}...")
        ports_data = proc.discover_ports(filename)
        
        # 3. 更新 JSON (SSOT)
        current_data = lib_manager.get_part(filename)
        current_data['ports'] = ports_data
        lib_manager.save_part(filename, current_data)
        
        print(f"[OK] {filename} 处理完成 (已同步网格与端口数据)")

if __name__ == "__main__":
    main()

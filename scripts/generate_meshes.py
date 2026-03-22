import os
import sys
import argparse
import numpy as np

# 设置路径
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'backend'))

from geometry_processor import GeometryProcessor
from core_constants import LDU_TO_SI

def main():
    parser = argparse.ArgumentParser(description="LDraw .dat 批量转换为 GLB (SI 米制归一化)")
    parser.add_argument("filenames", nargs="+", help="LDraw 文件名或 ID (例如 6558.dat)")
    parser.add_argument("--force", action="store_true", help="强制覆盖已生成的模型")
    parser.add_argument("--color", type=int, default=7, help="颜色代码 (默认 7: Light Gray)")
    args = parser.parse_args()

    # 1. 初始化几何处理器
    # LDRAW_PARTS_ROOT 会自动从环境变量获取
    ldraw_path = os.environ.get("LDRAW_PARTS_ROOT", os.path.join(os.getcwd(), "ldraw_lib"))
    mesh_out_root = os.path.join(os.getcwd(), "frontend", "public", "ldraw_meshes")
    os.makedirs(mesh_out_root, exist_ok=True)

    proc = GeometryProcessor(ldraw_path=ldraw_path)

    print(f"[*] 启动全量几何体预生产流程...")
    print(f"[*] 素材库: {ldraw_path}")
    print(f"[*] 输出路径: {mesh_out_root}")

    for filename in args.filenames:
        if not filename.lower().endswith(".dat"):
            filename += ".dat"
        
        output_name = f"{filename[:-4]}_c{args.color}.glb"
        output_path = os.path.join(mesh_out_root, output_name)

        if os.path.exists(output_path) and not args.force:
            print(f"[-] 跳过 (已存在): {filename}")
            continue

        print(f"[>] 转换中: {filename} ...")
        
        # 核心：此处调用改进后的 convert_to_glb
        # 我们将在 geometry_processor.py 中同步改进这个方法，加入 Y 轴翻转逻辑
        success = proc.convert_to_glb(filename, output_path, color_code=args.color)
        
        if success:
            print(f"[OK] 导出完成: {output_name}")
        else:
            print(f"[FAIL] 转换失败: {filename}")

if __name__ == "__main__":
    main()

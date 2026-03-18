import os
import sys
import numpy as np

# Add project root to path
project_root = r"d:\Users\hanerlv\Documents\workspace\lego_cad_sim"
sys.path.append(project_root)

from ldraw_parser import LDrawParser

parser = LDrawParser(ldraw_path=os.path.join(project_root, "ldraw_lib"))
ports = parser.parse_dat_file("6558.dat")

print(f"6558.dat 共有 {len(ports)} 个端口:")
for i, p in enumerate(ports):
    d = p.to_dict()
    pos_mm = [v * 1000 for v in d['position']]
    # We want to know where the ports are along the principal axis (usually X or Y in LDraw)
    # LDU_TO_SI = 0.0004
    # pos_ldu = [v / 0.0004 for v in d['position']]
    print(f"  [{i}] 类型: {d['type']}, 位置 (mm): {pos_mm}")

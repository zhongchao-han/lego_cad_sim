
import numpy as np
import os
from ldraw_parser import LDrawParser
import json

part_id = "6558"
parser = LDrawParser("ldraw_lib")
ports = parser.parse_dat_file(part_id + ".dat")

print(f"--- Port Data for {part_id} ---")
for i, port in enumerate(ports):
    d = port.to_dict()
    print(f"\nPort {i}:")
    print(f"  Type: {d['type']}")
    print(f"  Position: {d['position']}")
    # Convert position to LDU for easier reading
    pos_ldu = np.array(d['position']) / 0.0004
    print(f"  Position (LDU): {pos_ldu}")
    print(f"  Rotation Matrix:\n{np.array(d['rotation'])}")
    z_axis = np.array(d['rotation'])[:, 2]
    print(f"  Z-axis (Forward): {z_axis}")

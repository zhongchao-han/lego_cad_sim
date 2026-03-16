"""查看基元文件的几何数据量"""
from geometry_processor import GeometryProcessor
import numpy as np
import os

proc = GeometryProcessor(ldraw_path='ldraw_lib')

# 查看几个关键基元文件的几何量
primitives = ['beamhole.dat', 'connhole.dat', '2-4cyli.dat', 'rect2p.dat', 
              '1-4cyli.dat', '4-4cyli.dat', 'confric5.dat']

for prim in primitives:
    filepath = proc.resolve_path(prim)
    if not filepath:
        print(f'{prim}: NOT FOUND')
        continue
    
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        lines = f.readlines()
    
    t1 = t2 = t3 = t4 = t5 = 0
    refs = []
    for line in lines:
        parts = line.strip().split()
        if not parts: continue
        t = parts[0]
        if t == '1': 
            t1 += 1
            if len(parts) >= 15: refs.append(parts[-1].lower())
        elif t == '2': t2 += 1
        elif t == '3': t3 += 1
        elif t == '4': t4 += 1
        elif t == '5': t5 += 1
    
    print(f'{prim} (total lines={len(lines)}):')
    print(f'  T1={t1} T2={t2} T3={t3} T4={t4} T5={t5}')
    
    # 尝试提取几何
    v, f = proc.extract_geometry(prim)
    print(f'  提取: vertices={len(v)}, faces={len(f)}')
    
    if refs:
        print(f'  子文件引用: {refs}')
    print()

# 对比：LDView 通常一个 beam 3 应该有多少面
# 我们算一下理论值
print('\n=== 零件整体统计 ===')
for part in ['32523.dat', '32524.dat', '6558.dat']:
    v, f = proc.extract_geometry(part)
    print(f'{part}: vertices={len(v)}, faces={len(f)}')
    
    # 检查边界框
    if v:
        arr = np.array(v)
        print(f'  边界: x=[{arr[:,0].min():.1f}, {arr[:,0].max():.1f}], y=[{arr[:,1].min():.1f}, {arr[:,1].max():.1f}], z=[{arr[:,2].min():.1f}, {arr[:,2].max():.1f}]')
        
        # 该零件用 LDView 或 LDraw 标准应该的大致尺寸
        # 32523 = Beam 1x3: 约 60x10x10 LDU (长x宽x高)
        # 32524 = Beam 1x7: 约 140x10x10 LDU
        # 6558  = Pin 3L with friction: 约 60x10x10 LDU
        x_range = arr[:,0].max() - arr[:,0].min()
        y_range = arr[:,1].max() - arr[:,1].min()
        z_range = arr[:,2].max() - arr[:,2].min()
        print(f'  尺寸范围: dx={x_range:.1f} dy={y_range:.1f} dz={z_range:.1f} LDU')

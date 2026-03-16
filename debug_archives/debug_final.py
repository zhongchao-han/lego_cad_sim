"""最终诊断：检查 resolve_path 是否遗漏了某些 LDraw 子组件路径"""
from geometry_processor import GeometryProcessor
import numpy as np
import os

proc = GeometryProcessor(ldraw_path='ldraw_lib')

# 对每个 .dat 文件递归提取所有引用的文件名
def collect_all_refs(proc, filename, seen=None):
    if seen is None:
        seen = set()
    if filename in seen:
        return {}
    seen.add(filename)
    
    filepath = proc.resolve_path(filename)
    results = {}
    
    if not filepath:
        results[filename] = {'status': 'MISSING', 'path': None, 'children': []}
        return results
    
    results[filename] = {'status': 'FOUND', 'path': filepath, 'children': []}
    
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
        
        for line in lines:
            parts = line.strip().split()
            if not parts:
                continue
            line_type = parts[0]
            
            if line_type == '1' and len(parts) >= 15:
                child_file = parts[-1].lower()
                results[filename]['children'].append(child_file)
                sub = collect_all_refs(proc, child_file, seen)
                results.update(sub)
    except:
        pass
    
    return results

# 手动测试一些带路径前缀的子文件解析
test_files_with_paths = [
    's/32523s01.dat',
    '8/1-4cyli.dat', 
    '48/1-12cyli.dat',
    'p/1-4cyli.dat',
    'p/8/1-4cyli.dat',
    'p/48/1-12cyli.dat',
]

print('=== 测试带路径前缀的文件解析 ===')
for tf in test_files_with_paths:
    resolved = proc.resolve_path(tf)
    print(f'  resolve_path("{tf}") -> {resolved}')

# 查看 32523.dat 的第一层子文件
filepath = proc.resolve_path('32523.dat')
print(f'\n=== 32523.dat 文件内容 ===')
with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
    for i, line in enumerate(f.readlines()):
        print(f'{i+1:3d}: {line.rstrip()}')

# 查看 s/32523s01.dat 的内容（如果存在）
s_filepath = proc.resolve_path('s/32523s01.dat')
if s_filepath:
    print(f'\n=== s/32523s01.dat 文件内容 ===')
    with open(s_filepath, 'r', encoding='utf-8', errors='ignore') as f:
        lines = f.readlines()
    
    # 统计原始几何指令  
    type1_count = 0
    type3_count = 0
    type4_count = 0
    type2_count = 0
    type5_count = 0
    refs = []
    for line in lines:
        parts = line.strip().split()
        if not parts:
            continue
        t = parts[0]
        if t == '1':
            type1_count += 1
            if len(parts) >= 15:
                refs.append(parts[-1].lower())
        elif t == '2':
            type2_count += 1
        elif t == '3':
            type3_count += 1
        elif t == '4':
            type4_count += 1
        elif t == '5':
            type5_count += 1
    
    print(f'总行数: {len(lines)}')
    print(f'Type 1 (子文件引用): {type1_count}')
    print(f'Type 2 (线段 - 被跳过!): {type2_count}')
    print(f'Type 3 (三角形): {type3_count}')
    print(f'Type 4 (四边形): {type4_count}')
    print(f'Type 5 (条件线 - 被跳过!): {type5_count}')
    print(f'\n引用的子文件:')
    for ref in refs:
        resolved = proc.resolve_path(ref)
        status = 'OK' if resolved else 'MISSING'
        print(f'  {ref} -> {status}')

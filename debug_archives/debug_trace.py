"""调试脚本：递归追踪 LDraw 零件引用的子文件完整性"""
from geometry_processor import GeometryProcessor
import numpy as np

proc = GeometryProcessor(ldraw_path='ldraw_lib')

def trace_refs(proc, filename, depth=0, seen=None):
    if seen is None:
        seen = set()
    if filename in seen:
        return []
    seen.add(filename)
    
    filepath = proc.resolve_path(filename)
    if not filepath:
        return [(filename, depth, 'MISSING')]
    
    results = [(filename, depth, 'FOUND')]
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
        for line in lines:
            parts = line.strip().split()
            if parts and parts[0] == '1' and len(parts) >= 15:
                child_file = parts[-1].lower()
                results.extend(trace_refs(proc, child_file, depth+1, seen))
    except Exception:
        pass
    return results

for test_part in ['32523.dat', '32524.dat', '6558.dat']:
    print(f'\n=== 递归追踪 {test_part} ===')
    refs = trace_refs(proc, test_part)
    missing_files = [r for r in refs if r[2] == 'MISSING']
    found_files = [r for r in refs if r[2] == 'FOUND']
    print(f'总引用文件: {len(refs)}, 找到: {len(found_files)}, 缺失: {len(missing_files)}')
    if missing_files:
        print('\n缺失文件:')
        for name, depth, status in missing_files:
            indent = '  ' * depth
            print(f'  [{indent}] {name}')
    else:
        print('所有子文件均已找到！')

    # 测试提取的几何数据
    vertices, faces = proc.extract_geometry(test_part)
    print(f'提取结果: 顶点={len(vertices)}, 面片={len(faces)}')
    
    # 查看直接子文件引用
    filepath = proc.resolve_path(test_part)
    if filepath:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
        type1_count = 0
        type3_count = 0
        type4_count = 0
        for line in lines:
            parts = line.strip().split()
            if not parts:
                continue
            if parts[0] == '1':
                type1_count += 1
            elif parts[0] == '3':
                type3_count += 1
            elif parts[0] == '4':
                type4_count += 1
        print(f'直接指令统计: Type1(子文件引用)={type1_count}, Type3(三角形)={type3_count}, Type4(四边形)={type4_count}')

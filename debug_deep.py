"""诊断: 对比完整 LDraw 库 resolve 能力、以及带日志的几何提取"""
from geometry_processor import GeometryProcessor
import numpy as np
import logging
import os

# 开启详细日志
logging.basicConfig(level=logging.DEBUG, format='%(levelname)s: %(message)s')

proc = GeometryProcessor(ldraw_path='ldraw_lib')

# 记录所有解析过程中的成功和失败
class TracingProcessor(GeometryProcessor):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.resolved_files = []
        self.missing_files = []
        self.resolve_cache = {}
    
    def extract_geometry(self, filename, transform=np.eye(4)):
        filepath = self.resolve_path(filename)
        if not filepath:
            if filename not in self.resolve_cache:
                self.missing_files.append(filename)
                self.resolve_cache[filename] = None
            return [], []
        
        if filename not in self.resolve_cache:
            self.resolved_files.append(filename)
            self.resolve_cache[filename] = filepath
        
        vertices = []
        faces = []
        
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            return [], []

        for line in lines:
            parts = line.strip().split()
            if not parts:
                continue

            line_type = parts[0]

            if line_type == '1' and len(parts) >= 15:
                child_file = parts[-1].lower()
                try:
                    x, y, z = map(float, parts[2:5])
                    a, b, c, d, e, f_val, g, h, i = map(float, parts[5:14])
                    local_mat = np.array([
                        [a, b, c, x],
                        [d, e, f_val, y],
                        [g, h, i, z],
                        [0, 0, 0, 1]
                    ])
                    global_mat = transform @ local_mat
                    det = np.linalg.det(global_mat[:3, :3])
                    is_mirrored = det < 0
                    
                    child_v, child_f = self.extract_geometry(child_file, global_mat)
                    
                    offset = len(vertices)
                    vertices.extend(child_v)
                    for face in child_f:
                        f_arr = np.array(face) + offset
                        if is_mirrored:
                            faces.append(f_arr[::-1])
                        else:
                            faces.append(f_arr)
                except ValueError:
                    pass

            elif line_type == '3' and len(parts) >= 11:
                try:
                    v = []
                    for k in range(2, 11, 3):
                        p = np.array([float(parts[k]), float(parts[k+1]), float(parts[k+2]), 1.0])
                        v.append((transform @ p)[:3])
                    vertices.extend(v)
                    idx = len(vertices) - 3
                    faces.append(np.array([idx, idx+1, idx+2]))
                except ValueError:
                    pass

            elif line_type == '4' and len(parts) >= 14:
                try:
                    v = []
                    for k in range(2, 14, 3):
                        p = np.array([float(parts[k]), float(parts[k+1]), float(parts[k+2]), 1.0])
                        v.append((transform @ p)[:3])
                    vertices.extend(v)
                    idx = len(vertices) - 4
                    faces.append(np.array([idx, idx+1, idx+2]))
                    faces.append(np.array([idx, idx+2, idx+3]))
                except ValueError:
                    pass

        return vertices, faces

proc2 = TracingProcessor(ldraw_path='ldraw_lib')

# 检查 6558.dat 在文件中引用哪些子组件
filepath = proc.resolve_path('6558.dat')
print(f'\n=== 6558.dat 文件内容 (Type 1 子文件行) ===')
with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
    for line in f.readlines():
        parts = line.strip().split()
        if parts and parts[0] == '1':
            child = parts[-1] if len(parts) >= 15 else 'PARSE_ERROR'
            resolved = proc.resolve_path(child.lower())
            print(f'  {child} -> {resolved}')

# 提取几何
vertices, faces = proc2.extract_geometry('6558.dat')
print(f'\n总解析文件:')
for fn in sorted(proc2.resolved_files):
    print(f'  OK: {fn}')
if proc2.missing_files:
    print(f'\n缺失文件:')
    for fn in sorted(proc2.missing_files):
        print(f'  MISSING: {fn}')
else:
    print('\n无缺失文件')

print(f'\n最终: vertices={len(vertices)}, faces={len(faces)}')

# 检查 p/ 子目录内容
p_dir = os.path.join('ldraw_lib', 'p')
p_subdirs = [d for d in os.listdir(p_dir) if os.path.isdir(os.path.join(p_dir, d))]
print(f'\np/ 子目录: {p_subdirs}')
for sd in p_subdirs:
    count = len(os.listdir(os.path.join(p_dir, sd)))
    print(f'  {sd}/: {count} 个文件')

parts_dir = os.path.join('ldraw_lib', 'parts')
parts_subdirs = [d for d in os.listdir(parts_dir) if os.path.isdir(os.path.join(parts_dir, d))]
print(f'\nparts/ 子目录: {parts_subdirs}')
for sd in parts_subdirs:
    count = len(os.listdir(os.path.join(parts_dir, sd)))
    print(f'  {sd}/: {count} 个文件')

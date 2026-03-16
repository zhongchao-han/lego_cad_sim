"""对比处理与未处理的 GLB 导出结果"""
from geometry_processor import GeometryProcessor
import numpy as np
import trimesh
import os

proc = GeometryProcessor(ldraw_path='ldraw_lib')
LDU_TO_SI = 0.0004

for part in ['32523.dat', '6558.dat']:
    print(f'\n{"="*60}')
    print(f'零件: {part}')
    print(f'{"="*60}')
    
    vertices, faces = proc.extract_geometry(part)
    v_arr = np.array(vertices) * LDU_TO_SI
    f_arr = np.array(faces)
    
    # 方式 1: 默认处理 (当前代码)
    mesh1 = trimesh.Trimesh(vertices=v_arr, faces=f_arr)
    mesh1.export(f'ldraw_meshes/{part.replace(".dat","")}_default.glb', file_type='glb')
    
    # 方式 2: 禁用处理
    mesh2 = trimesh.Trimesh(vertices=v_arr, faces=f_arr, process=False)
    mesh2.export(f'ldraw_meshes/{part.replace(".dat","")}_noprocess.glb', file_type='glb')
    
    # 方式 3: 使用 GLB 场景方式导出（保留法线计算） 
    mesh3 = trimesh.Trimesh(vertices=v_arr, faces=f_arr, process=False)
    # 计算顶点法线
    mesh3.fix_normals()
    mesh3.export(f'ldraw_meshes/{part.replace(".dat","")}_fixednormals.glb', file_type='glb')
    
    print(f'默认处理: vertices={len(mesh1.vertices)}, faces={len(mesh1.faces)}, watertight={mesh1.is_watertight}')
    print(f'未处理:   vertices={len(mesh2.vertices)}, faces={len(mesh2.faces)}, watertight={mesh2.is_watertight}')
    print(f'修复法线: vertices={len(mesh3.vertices)}, faces={len(mesh3.faces)}, watertight={mesh3.is_watertight}')
    
    # 检查法线
    if hasattr(mesh1, 'face_normals') and len(mesh1.face_normals) > 0:
        # 检查是否有翻转的法线(内向外)
        center = mesh1.centroid
        normals = mesh1.face_normals
        centroids = mesh1.triangles_center
        
        outward = 0
        inward = 0
        for i in range(len(normals)):
            direction = centroids[i] - center
            dot = np.dot(normals[i], direction)
            if dot >= 0:
                outward += 1
            else:
                inward += 1
        
        print(f'法线方向: 朝外={outward}, 朝内={inward} (理想情况下应全部朝外)')

    # 检查文件大小
    for suffix in ['_default', '_noprocess', '_fixednormals']:
        fn = f'ldraw_meshes/{part.replace(".dat","")}{suffix}.glb'
        size = os.path.getsize(fn)
        print(f'  {suffix}.glb: {size} bytes')

"""深入诊断几何处理中的面片问题"""
from geometry_processor import GeometryProcessor
import numpy as np
import trimesh

proc = GeometryProcessor(ldraw_path='ldraw_lib')

for test_part in ['32523.dat', '6558.dat']:
    print(f'\n{"="*60}')
    print(f'分析零件: {test_part}')
    print(f'{"="*60}')
    
    vertices, faces = proc.extract_geometry(test_part)
    
    v_arr = np.array(vertices)
    f_arr = np.array(faces)
    
    print(f'原始顶点数: {len(v_arr)}')
    print(f'原始面片数: {len(f_arr)}')
    
    # 检查面片索引的合法范围
    if len(f_arr) > 0:
        max_idx = f_arr.max()
        min_idx = f_arr.min()
        print(f'面片索引范围: [{min_idx}, {max_idx}]')
        
        # 检查是否有超范围索引
        invalid = f_arr >= len(v_arr)
        if invalid.any():
            print(f'!!! 存在 {invalid.sum()} 个超范围索引!')
        else:
            print('所有面片索引范围合法')
        
        # 检查面片形状
        face_shapes = set()
        for f in faces:
            face_shapes.add(len(f))
        print(f'面片顶点数种类: {face_shapes}')
    
    # 尝试构建 trimesh 并查看效果
    LDU_TO_SI = 0.0004
    try:
        mesh = trimesh.Trimesh(
            vertices=v_arr * LDU_TO_SI,
            faces=f_arr,
            process=False  # 不要自动处理
        )
        print(f'\n未处理的 Trimesh:')
        print(f'  vertices: {len(mesh.vertices)}, faces: {len(mesh.faces)}')
        print(f'  watertight: {mesh.is_watertight}')
        print(f'  volume: {mesh.volume:.12f}')
        
        # 再试有 process 的
        mesh2 = trimesh.Trimesh(
            vertices=v_arr * LDU_TO_SI,
            faces=f_arr,
            process=True
        )
        print(f'\n自动处理后的 Trimesh:')
        print(f'  vertices: {len(mesh2.vertices)}, faces: {len(mesh2.faces)}')
        
        diff = len(mesh.faces) - len(mesh2.faces)
        if diff > 0:
            print(f'  !!! 处理后丢失了 {diff} 个面片!')
        
    except Exception as e:
        print(f'构建 Trimesh 失败: {e}')

    # 检查面片法线方向一致性
    print(f'\n检查前 10 个面片:')
    for i in range(min(10, len(faces))):
        f = faces[i]
        if len(f) == 3:
            v0, v1, v2 = v_arr[f[0]], v_arr[f[1]], v_arr[f[2]]
            normal = np.cross(v1-v0, v2-v0)
            area = np.linalg.norm(normal) / 2
            if area < 1e-10:
                print(f'  面片 {i}: 退化面(面积=0)')
            else:
                print(f'  面片 {i}: 正常, 面积={area:.6f}')
    
    # 检查退化面片数量
    degen_count = 0
    for f in faces:
        if len(f) == 3:
            v0, v1, v2 = v_arr[f[0]], v_arr[f[1]], v_arr[f[2]]
            normal = np.cross(v1-v0, v2-v0)
            area = np.linalg.norm(normal) / 2
            if area < 1e-10:
                degen_count += 1
    print(f'\n退化面片总数: {degen_count} / {len(faces)}')

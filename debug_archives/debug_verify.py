"""验证修复后的几何体法线方向"""
from geometry_processor import GeometryProcessor
import numpy as np
import trimesh

proc = GeometryProcessor(ldraw_path='ldraw_lib')
LDU_TO_SI = 0.0004

for part in ['32523.dat', '32524.dat', '6558.dat']:
    print(f'\n{"="*50}')
    print(f'零件: {part}')
    
    vertices, faces = proc.extract_geometry(part)
    v_arr = np.array(vertices) * LDU_TO_SI
    f_arr = np.array(faces)
    
    mesh = trimesh.Trimesh(vertices=v_arr, faces=f_arr, process=False)
    
    # 检查法线方向 
    center = mesh.centroid
    normals = mesh.face_normals
    centroids = mesh.triangles_center
    
    outward = 0
    inward = 0
    for i in range(len(normals)):
        direction = centroids[i] - center
        dot = np.dot(normals[i], direction)
        if dot >= 0:
            outward += 1
        else:
            inward += 1
    
    total = outward + inward
    pct = outward / total * 100 if total > 0 else 0
    print(f'  顶点: {len(vertices)}, 面片: {len(faces)}')
    print(f'  法线朝外: {outward} ({pct:.1f}%), 朝内: {inward} ({100-pct:.1f}%)')
    
    # 重新生成 GLB
    output = f'ldraw_meshes/{part.replace(".dat", "")}.glb'
    proc.convert_to_glb(part, output)
    
    # 验证 GLB
    loaded = trimesh.load(output, force='mesh')
    print(f'  导出后 GLB: vertices={len(loaded.vertices)}, faces={len(loaded.faces)}')

print('\n修复完成！')

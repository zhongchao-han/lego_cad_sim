import os
import trimesh
import numpy as np
import logging
from typing import List, Tuple, Optional

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

class GeometryProcessor:
    """
    负责将 LDraw (.dat) 几何体转换为 Web 可用的网格格式 (.glb)。
    """
    
    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.ldraw_path = ldraw_path
        self.parts_path = os.path.join(ldraw_path, "parts")
        self.p_path = os.path.join(ldraw_path, "p")
        
    def resolve_path(self, filename: str) -> Optional[str]:
        """根据 LDraw 规则寻找文件的绝对路径。"""
        filename = filename.lower().replace('\\', '/')
        
        # 搜索逻辑与 LDrawParser 一致
        full_path = os.path.normpath(os.path.join(self.ldraw_path, filename))
        if os.path.exists(full_path): return full_path

        search_roots = [self.parts_path, self.p_path]
        for root in search_roots:
            p = os.path.normpath(os.path.join(root, filename))
            if os.path.exists(p): return p

        search_dirs = [
            self.parts_path, self.p_path,
            os.path.join(self.parts_path, "s"),
            os.path.join(self.p_path, "48")
        ]
        file_basename = os.path.basename(filename)
        for d in search_dirs:
            p = os.path.normpath(os.path.join(d, file_basename))
            if os.path.exists(p): return p
        return None

    def extract_geometry(self, filename: str, transform: np.ndarray = np.eye(4)) -> Tuple[List[np.ndarray], List[np.ndarray]]:
        """
        递归提取 LDraw 文件中的几何顶点。
        返回: (vertices_list, faces_list)
        """
        filepath = self.resolve_path(filename)
        if not filepath:
            return [], []

        vertices = []
        faces = []
        
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            logger.error(f"读取文件失败 {filepath}: {e}")
            return [], []

        for line in lines:
            parts = line.strip().split()
            if not parts: continue

            line_type = parts[0]

            # Type 1: 引用另一个文件 (递归)
            if line_type == '1' and len(parts) >= 15:
                child_file = parts[-1].lower()
                try:
                    x, y, z = map(float, parts[2:5])
                    a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
                    local_mat = np.array([
                        [a, b, c, x],
                        [d, e, f, y],
                        [g, h, i, z],
                        [0, 0, 0, 1]
                    ])
                    global_mat = transform @ local_mat
                    child_v, child_f = self.extract_geometry(child_file, global_mat)
                    vertices.extend(child_v)
                    faces.extend(child_f)
                except ValueError: pass

            # Type 3: 三角形 (1 colour x1 y1 z1 x2 y2 z2 x3 y3 z3)
            elif line_type == '3' and len(parts) >= 11:
                try:
                    v = []
                    for k in range(2, 11, 3):
                        p = np.array([float(parts[k]), float(parts[k+1]), float(parts[k+2]), 1.0])
                        v.append((transform @ p)[:3])
                    vertices.extend(v)
                    idx = len(vertices) - 3
                    faces.append(np.array([idx, idx+1, idx+2]))
                except ValueError: pass

            # Type 4: 四边形 (1 colour x1 y1 z1 x2 y2 z2 x3 y3 z3 x4 y4 z4)
            # 转换为两个三角形
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
                except ValueError: pass

        return vertices, faces

    def convert_to_glb(self, dat_filename: str, output_path: str) -> bool:
        """
        核心转换函数: .dat -> .glb
        """
        logger.info(f"正在转换几何体: {dat_filename} -> {output_path}")
        
        # 比例系数 LDU -> Meters
        LDU_TO_SI = 0.0004
        
        # 旋转矩阵校正: LDraw Y轴向下，而 Web/GLTF 通常 Y轴向上
        # 我们在这里预应用一个 180 度翻转或者保持原样由前端处理？
        # LDraw 坐标系通常为 (X, -Y, -Z) 对应 (Right, Up, Forward)
        # 为保持一致性，我们暂时只缩放。
        
        vertices, faces = self.extract_geometry(dat_filename)
        
        if not vertices or not faces:
            logger.warning(f"未能提取到有效几何数据: {dat_filename}")
            return False

        try:
            # 构建 mesh (应用缩放)
            mesh = trimesh.Trimesh(
                vertices=np.array(vertices) * LDU_TO_SI,
                faces=np.array(faces)
            )
            
            # 导出为 GLB (二进制 glTF)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            mesh.export(output_path, file_type='glb')
            logger.info(f"转换成功: {output_path}")
            return True
        except Exception as e:
            logger.error(f"构建或导出网格失败: {e}")
            return False

if __name__ == "__main__":
    # 小型本地测试
    proc = GeometryProcessor(ldraw_path="ldraw_lib")
    test_part = "32523.dat"
    out_file = "ldraw_meshes/32523.glb"
    proc.convert_to_glb(test_part, out_file)

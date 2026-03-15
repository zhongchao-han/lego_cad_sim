import os
import trimesh
import numpy as np
import re
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
        self.color_table = self._load_color_table()
        
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

    def _load_color_table(self) -> dict:
        """Parse LDConfig.ldr to build {color_code: (R, G, B, A)} mapping."""
        colors = {}
        config_path = os.path.join(self.ldraw_path, "LDConfig.ldr")
        if not os.path.exists(config_path):
            logger.warning("LDConfig.ldr not found, colors will fall back to gray")
            return colors
        try:
            with open(config_path, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    if '!COLOUR' not in line:
                        continue
                    code_m = re.search(r'CODE\s+(\d+)', line)
                    val_m = re.search(r'VALUE\s+#([0-9A-Fa-f]{6})', line)
                    if not (code_m and val_m):
                        continue
                    code = int(code_m.group(1))
                    hx = val_m.group(1)
                    r, g, b = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
                    alpha_m = re.search(r'ALPHA\s+(\d+)', line)
                    a = int(alpha_m.group(1)) if alpha_m else 255
                    colors[code] = (r, g, b, a)
            logger.info(f"Loaded {len(colors)} colors from LDConfig.ldr")
        except Exception as e:
            logger.warning(f"Failed to load LDConfig.ldr: {e}")
        return colors

    def _resolve_color(self, color_code: int) -> Tuple[int, int, int, int]:
        """Resolve an LDraw color code to (R, G, B, A)."""
        if color_code in self.color_table:
            return self.color_table[color_code]
        if color_code == 24:
            return (51, 51, 51, 255)
        return (127, 127, 127, 255)

    def extract_geometry(self, filename: str, transform: np.ndarray = np.eye(4), parent_color_code: int = 16) -> Tuple[List[np.ndarray], List[np.ndarray], List[Tuple]]:
        """
        递归提取 LDraw 文件中的几何顶点和每顶点颜色。
        返回: (vertices_list, faces_list, vertex_colors_list)
        
        法线翻转策略：
        - 面片绕序翻转仅在叶子节点（Type 3/4）处根据全局变换行列式一次性决定
        - Type 1 递归收集时不再额外翻转子文件返回的面片
        """
        filepath = self.resolve_path(filename)
        if not filepath:
            return [], [], []

        vertices = []
        faces = []
        vertex_colors = []
        
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            logger.error(f"读取文件失败 {filepath}: {e}")
            return [], [], []

        det = np.linalg.det(transform[:3, :3])
        is_mirrored = det < 0

        for line in lines:
            parts = line.strip().split()
            if not parts: continue

            line_type = parts[0]

            if line_type == '1' and len(parts) >= 15:
                child_file = parts[-1].lower()
                try:
                    color_code = int(parts[1])
                    effective_color = parent_color_code if color_code == 16 else color_code

                    x, y, z = map(float, parts[2:5])
                    a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
                    local_mat = np.array([
                        [a, b, c, x],
                        [d, e, f, y],
                        [g, h, i, z],
                        [0, 0, 0, 1]
                    ])
                    global_mat = transform @ local_mat
                    
                    child_v, child_f, child_vc = self.extract_geometry(child_file, global_mat, effective_color)
                    
                    offset = len(vertices)
                    vertices.extend(child_v)
                    vertex_colors.extend(child_vc)
                    for face in child_f:
                        f_arr = np.array(face) + offset
                        faces.append(f_arr)
                except ValueError: pass

            elif line_type == '3' and len(parts) >= 11:
                try:
                    color_code = int(parts[1])
                    effective_color = parent_color_code if color_code == 16 else color_code
                    rgba = self._resolve_color(effective_color)

                    v = []
                    for k in range(2, 11, 3):
                        p = np.array([float(parts[k]), float(parts[k+1]), float(parts[k+2]), 1.0])
                        v.append((transform @ p)[:3])
                    vertices.extend(v)
                    vertex_colors.extend([rgba] * 3)
                    idx = len(vertices) - 3
                    if is_mirrored:
                        faces.append(np.array([idx, idx+2, idx+1]))
                    else:
                        faces.append(np.array([idx, idx+1, idx+2]))
                except ValueError: pass

            elif line_type == '4' and len(parts) >= 14:
                try:
                    color_code = int(parts[1])
                    effective_color = parent_color_code if color_code == 16 else color_code
                    rgba = self._resolve_color(effective_color)

                    v = []
                    for k in range(2, 14, 3):
                        p = np.array([float(parts[k]), float(parts[k+1]), float(parts[k+2]), 1.0])
                        v.append((transform @ p)[:3])
                    vertices.extend(v)
                    vertex_colors.extend([rgba] * 4)
                    idx = len(vertices) - 4
                    if is_mirrored:
                        faces.append(np.array([idx, idx+2, idx+1]))
                        faces.append(np.array([idx, idx+3, idx+2]))
                    else:
                        faces.append(np.array([idx, idx+1, idx+2]))
                        faces.append(np.array([idx, idx+2, idx+3]))
                except ValueError: pass

        return vertices, faces, vertex_colors

    def convert_to_glb(self, dat_filename: str, output_file: str, color_code: int = 7) -> bool:
        """
        核心转换函数: .dat -> .glb（带颜色）
        """
        success = self.convert_to_glb_internal(dat_filename, output_file, color_code)
        return success

    def convert_to_glb_internal(self, dat_filename: str, output_path: str, color_code: int = 7) -> bool:
        """
        内部转换函数，返回 trimesh 对象以便后续碰撞检测使用。
        """
        logger.info(f"正在转换几何体: {dat_filename} -> {output_path} (color={color_code})")
        
        LDU_TO_SI = 0.0004
        
        vertices, faces, vertex_colors = self.extract_geometry(
            dat_filename, parent_color_code=color_code
        )
        
        if not vertices or not faces:
            logger.warning(f"未能提取到有效几何数据: {dat_filename}")
            return None

        try:
            verts_arr = np.array(vertices) * LDU_TO_SI
            faces_arr = np.array(faces)

            if vertex_colors:
                vc_arr = np.array(vertex_colors, dtype=np.uint8)
            else:
                rgba = self._resolve_color(color_code)
                vc_arr = np.tile(np.array(rgba, dtype=np.uint8), (len(verts_arr), 1))

            mesh = trimesh.Trimesh(
                vertices=verts_arr,
                faces=faces_arr,
                vertex_colors=vc_arr,
                process=False
            )
            
            mesh.fix_normals()
            
            if output_path:
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                export_data = trimesh.exchange.gltf.export_glb(scene=trimesh.Scene(mesh))
                with open(output_path, 'wb') as f:
                    f.write(export_data)
                logger.info(f"转换成功: {output_path}")
            
            return mesh
        except Exception as e:
            logger.error(f"构建或导出网格失败: {e}")
            return None

    def create_collision_manager(self, part_data_list: List[dict]) -> trimesh.collision.CollisionManager:
        """
        创建一个碰撞管理器，并预加载所有已有的零件。
        part_data_list: [{'name': '32523.dat', 'transform': 4x4_np_array}, ...]
        """
        cm = trimesh.collision.CollisionManager()
        for i, item in enumerate(part_data_list):
            mesh = self.convert_to_glb_internal(item['name'], None)
            if mesh:
                cm.add_object(f"part_{i}", mesh, transform=item['transform'])
        return cm

    def check_collision(self, cm: trimesh.collision.CollisionManager, 
                        new_part_name: str, new_transform: np.ndarray) -> bool:
        """
        检测新零件在指定位姿下是否与现有零件发生静态碰撞。
        """
        new_mesh = self.convert_to_glb_internal(new_part_name, None)
        if not new_mesh:
            return False
        
        # in_collision 返回布尔值
        return cm.in_collision_single(new_mesh, transform=new_transform)

    def get_cross_section_profile(self, dat_filename: str, axis: int = 0, num_slices: int = 30) -> Optional[dict]:
        """
        沿指定轴切片，计算零件在每个位置的截面半径（到轴心的最大距离）。
        返回: { axis_positions: [...], radii: [...], bbox_min: [...], bbox_max: [...] }
        单位: SI (meters)
        :param axis: 0=X, 1=Y, 2=Z
        """
        LDU_TO_SI = 0.0004
        vertices, faces, _ = self.extract_geometry(dat_filename)
        if not vertices:
            return None
        
        verts = np.array(vertices) * LDU_TO_SI
        
        bbox_min = verts.min(axis=0)
        bbox_max = verts.max(axis=0)
        
        axis_min = bbox_min[axis]
        axis_max = bbox_max[axis]
        
        cross_axes = [i for i in range(3) if i != axis]
        
        positions = np.linspace(axis_min, axis_max, num_slices)
        radii = []
        slice_thickness = (axis_max - axis_min) / num_slices * 1.5
        
        for pos in positions:
            mask = np.abs(verts[:, axis] - pos) < slice_thickness
            nearby = verts[mask]
            if len(nearby) == 0:
                radii.append(0.0)
                continue
            dists = np.sqrt(nearby[:, cross_axes[0]]**2 + nearby[:, cross_axes[1]]**2)
            radii.append(float(np.max(dists)))
        
        return {
            "axis": axis,
            "axis_positions": positions.tolist(),
            "radii": radii,
            "bbox_min": bbox_min.tolist(),
            "bbox_max": bbox_max.tolist(),
        }

    def get_hole_radius(self, dat_filename: str, hole_axis: int = 1) -> Optional[float]:
        """
        估算梁孔的内径：在孔位处沿 hole_axis 的中心截面上，找最小内圈距离。
        返回: 孔的半径 (SI)
        """
        LDU_TO_SI = 0.0004
        vertices, faces, _ = self.extract_geometry(dat_filename)
        if not vertices:
            return None
        
        verts = np.array(vertices) * LDU_TO_SI
        
        cross_axes = [i for i in range(3) if i != hole_axis]
        
        center_mask = np.abs(verts[:, hole_axis]) < 0.001
        center_verts = verts[center_mask]
        if len(center_verts) == 0:
            return None
        
        dists = np.sqrt(center_verts[:, cross_axes[0]]**2 + center_verts[:, cross_axes[1]]**2)
        inner_verts = center_verts[dists < np.median(dists)]
        if len(inner_verts) == 0:
            return None
        
        inner_dists = np.sqrt(inner_verts[:, cross_axes[0]]**2 + inner_verts[:, cross_axes[1]]**2)
        return float(np.max(inner_dists))



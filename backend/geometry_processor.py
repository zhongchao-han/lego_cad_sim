import os
import trimesh
import numpy as np
import re
import logging
from typing import List, Dict, Tuple, Optional, Any
from backend.port_library import PortLibrary
from backend.core_constants import LDU_TO_SI, LEGO_GRID_METERS
from backend.math_utils import CoordinateTransformer, purify_rotation_matrix, matrix_to_list

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# 物理常量 - 精确匹配清单 (避免递归到子原语导致双重计数)
SEMANTIC_PRIMITIVES = [
    "peghole.dat", "axlehole.dat", "pin.dat", "axle.dat", "halfpin.dat", 
    "connect.dat", "beamhole.dat", "connhole.dat", "bush.dat", "crosshole.dat",
    "axlehol8.dat", "axleend2.dat", "fric_pin.dat"
]
CONNECTOR_PREFIXES = ["axle", "pin", "hole", "peg", "confric"]

# 特殊原语的单位步长补偿 (LDU)
KNOWN_UNIT_LENGTHS = {
    "axlehol8.dat": 5.75,
    "confric3": 2.0, 
    "confric6": 2.0
}

def calculate_p2p_alignment(source_port: 'Port', target_port: 'Port') -> np.ndarray:
    """
    [Interaction v1.2] 计算将 Source 零件对齐到 Target 端口的 4x4 变换矩阵。
    基于 Z 轴反向对冲原则。
    """
    from scipy.spatial.transform import Rotation
    src_z = source_port.rotation[:, 2]
    parent_z = -target_port.rotation[:, 2]
    
    dot_val = np.dot(src_z, parent_z)
    if np.allclose(src_z, parent_z):
        rot_matrix = np.eye(3)
    elif np.allclose(src_z, -parent_z):
        ortho_vec = np.array([1, 0, 0]) if abs(src_z[0]) < 0.9 else np.array([0, 1, 0])
        rot_axis = np.cross(src_z, ortho_vec)
        rot_matrix = Rotation.from_rotvec(np.pi * (rot_axis / np.linalg.norm(rot_axis))).as_matrix()
    else:
        cross_vec = np.cross(src_z, parent_z)
        rot_matrix = Rotation.from_rotvec(cross_vec / (np.linalg.norm(cross_vec) + 1e-9) * np.arccos(np.clip(dot_val, -1.0, 1.0))).as_matrix()
    
    translated_src_pos = rot_matrix @ source_port.position
    translation = target_port.position - translated_src_pos
    matrix = np.eye(4)
    matrix[:3, :3] = rot_matrix
    matrix[:3, 3] = translation
    return matrix

class GeometryProcessor:
    """
    全能加工厂：负责将 LDraw (.dat) 几何体转换为归一化资产 (GLB + Ports)。
    单一责任: 负责文件解析与树状遍历。
    """
    
    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.ldraw_path = ldraw_path
        self.color_table = self._load_color_table()
        
    def resolve_path(self, filename: str) -> Optional[str]:
        return PortLibrary.resolve_path(self.ldraw_path, filename)

    def _load_color_table(self) -> dict:
        colors = {}
        config_path = os.path.join(self.ldraw_path, "LDConfig.ldr")
        if not os.path.exists(config_path): return colors
        try:
            with open(config_path, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    if '!COLOUR' not in line: continue
                    code_m = re.search(r'CODE\s+(\d+)', line)
                    val_m = re.search(r'VALUE\s+#([0-9A-Fa-f]{6})', line)
                    if not (code_m and val_m): continue
                    code, hx = int(code_m.group(1)), val_m.group(1)
                    r, g, b = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
                    alpha_m = re.search(r'ALPHA\s+(\d+)', line)
                    a = int(alpha_m.group(1)) if alpha_m else 255
                    colors[code] = (r, g, b, a)
        except (FileNotFoundError, IOError, ValueError) as e:
            logger.warning(f"Failed to load color table from {config_path}: {e}")
        return colors

    def _resolve_color(self, color_code: int) -> Tuple[int, int, int, int]:
        return self.color_table.get(color_code, (255, 0, 255, 255))

    def extract_geometry(self, filename: str, global_mat: np.ndarray = np.eye(4), parent_color_code: int = 7, inverted: bool = False) -> Tuple[List[np.ndarray], List[np.ndarray], List[Tuple]]:
        """
        递归地从 .dat 文件中提取几何信息。
        """
        logger.debug(f"[DEBUG] 进入 extract_geometry: filename={filename}, color={parent_color_code}, inverted={inverted}")
        filepath = self.resolve_path(filename)
        if not filepath: return [], [], []
        vertices, faces, vertex_colors = [], [], []
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except (FileNotFoundError, IOError, ValueError) as e:
            logger.error(f"Failed to extract geometry from {filepath}: {e}", exc_info=True)
            return [], [], []
        
        det = np.linalg.det(global_mat[:3, :3])
        is_mirrored = (det < 0) ^ inverted
        bfc_invert_next = False
        
        for line in lines:
            parts = line.strip().split()
            if not parts: continue
            line_type = parts[0]
            if line_type == '0':
                if len(parts) >= 3 and parts[1] == 'BFC' and parts[2] == 'INVERTNEXT': 
                    bfc_invert_next = True
                continue
            
            if line_type == '1' and len(parts) >= 15:
                child_file = parts[-1].lower()
                try:
                    color_code = int(parts[1])
                    effective_color = parent_color_code if color_code == 16 else color_code
                    x, y, z = map(float, parts[2:5])
                    a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
                    local_mat = np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1]])
                    child_global_mat = global_mat @ local_mat
                    cv, cf, cvc = self.extract_geometry(child_file, child_global_mat, effective_color, inverted=bfc_invert_next)
                    offset = len(vertices)
                    vertices.extend(cv); vertex_colors.extend(cvc)
                    for face in cf: faces.append(np.array(face) + offset)
                except ValueError: pass
                finally: bfc_invert_next = False
                
            elif line_type in ['3', '4']:
                try:
                    num_pts = int(line_type)
                    color_code = int(parts[1])
                    rgba = self._resolve_color(parent_color_code if color_code == 16 else color_code)
                    v = []
                    for k in range(2, 2 + num_pts * 3, 3):
                        p = np.array([float(parts[k]), float(parts[k+1]), float(parts[k+2]), 1.0])
                        v.append((global_mat @ p)[:3])
                    vertices.extend(v); vertex_colors.extend([rgba] * num_pts)
                    idx = len(vertices) - num_pts
                    if is_mirrored:
                        faces.append(np.array([idx, idx+2, idx+1]))
                        if num_pts == 4: faces.append(np.array([idx, idx+3, idx+2]))
                    else:
                        faces.append(np.array([idx, idx+1, idx+2]))
                        if num_pts == 4: faces.append(np.array([idx, idx+2, idx+3]))
                except ValueError: pass
                finally: bfc_invert_next = False
        return vertices, faces, vertex_colors

    def convert_to_glb(self, dat_filename: str, output_path: str, color_code: int = 7) -> bool:
        """
        将 LDraw 零件转换为 GLB 文件。
        """
        logger.debug(f"[DEBUG] 进入 convert_to_glb: dat_filename={dat_filename}, output={output_path}, color={color_code}")
        vertices, faces, vertex_colors = self.extract_geometry(dat_filename, parent_color_code=color_code)
        if not vertices or not faces: return False
        try:
            verts_arr = np.array(vertices)
            # Rx180 翻转 + SI 缩放
            verts_arr = (CoordinateTransformer.get_rx180() @ verts_arr.T).T * CoordinateTransformer.LDU_TO_SI
            mesh = trimesh.Trimesh(vertices=verts_arr, faces=np.array(faces), 
                                   vertex_colors=np.array(vertex_colors, dtype=np.uint8) if vertex_colors else None, 
                                   process=False)
            mesh.fix_normals()
            
            # 路径安全检查
            dir_name = os.path.dirname(output_path)
            if dir_name: os.makedirs(dir_name, exist_ok=True)
            
            export_data = trimesh.exchange.gltf.export_glb(scene=trimesh.Scene(mesh))
            with open(output_path, 'wb') as f: f.write(export_data)
            return True
        except Exception as e:
            logger.error(f"GLB 导出失败: {e}")
            return False

    def discover_ports(self, filename: str, global_mat: np.ndarray = np.eye(4), root_id: str = None) -> List[Dict[str, Any]]:
        """
        地毯式递归扫描：从零件源文件中发现所有潜在的物理端口。
        """
        logger.debug(f"[DEBUG] 进入 discover_ports: filename={filename}, root_id={root_id}")
        if root_id is None: root_id = filename.replace(".dat", "")
        filepath = self.resolve_path(filename)
        if not filepath: return []
        
        discovered = []
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except (FileNotFoundError, IOError, ValueError) as e:
            logger.error(f"Failed to discover ports from {filepath}: {e}", exc_info=True)
            return []

        for line in lines:
            parts = line.strip().split()
            if not parts or parts[0] != '1': continue
            child_file = parts[-1].lower()
            x, y, z = map(float, parts[2:5])
            a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
            local_mat = np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1]])
            current_global_mat = global_mat @ local_mat
            
            if child_file in SEMANTIC_PRIMITIVES or any(child_file.startswith(p) for p in CONNECTOR_PREFIXES):
                y_scale = np.linalg.norm(current_global_mat[:3, 1])
                
                # 采样步长判定
                base_unit_len = 1.0
                for k, v in KNOWN_UNIT_LENGTHS.items():
                    if k in child_file:
                        base_unit_len = v; break
                
                length_ldu = y_scale * base_unit_len * 20.0 if y_scale <= 10.0 else y_scale
                num_units = max(1, int(round(length_ldu / 20.0)))
                
                # 方向判定 (Pin/Axle 为 MALE, Z轴朝外)
                is_extruding = any(x in child_file for x in ["peg", "pin", "axle", "confric"])
                step_dir = -1.0 if is_extruding else 1.0
                
                for k in range(num_units):
                    offset_y = k * 20.0 * step_dir
                    lv = np.array([0, offset_y / y_scale, 0, 1])
                    p_mat = current_global_mat @ np.array([[1,0,0,lv[0]], [0,1,0,lv[1]], [0,0,1,lv[2]], [0,0,0,1]])
                    
                    # 强制正交化与右手系检阅
                    pure_rot_ldu = purify_rotation_matrix(p_mat[:3, :3])
                    final_rot = CoordinateTransformer.normalize_rot(pure_rot_ldu)
                    
                    # 生成唯一端口名
                    port_name = f"{root_id}_p{len(discovered)}"
                    discovered.append({
                        "name": port_name,
                        "type": child_file,
                        "position": CoordinateTransformer.normalize_pos(p_mat[:3, 3]).tolist(),
                        "rotation": final_rot.tolist()
                    })
            else:
                # 递归发现子部件端口
                discovered.extend(self.discover_ports(child_file, current_global_mat, root_id=root_id))
        return discovered

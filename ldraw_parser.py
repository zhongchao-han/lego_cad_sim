import os
import json
import logging
from typing import Dict, List, Optional, Any

import numpy as np
import trimesh

# 配置日志记录
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# --- 全局常量 ---
# 将 LDU (LDraw Units) 转换为 SI (meters) 的比例系数
# 根据文档：1 LDU = 0.0004m
LDU_TO_SI = 0.0004
# ABS 塑料材料密度，设置给网格物理属性
ABS_DENSITY = 1040.0  # kg/m^3

# 要识别的语义原件后缀名，用于 LDraw 数据提取的语义约束建模
SEMANTIC_PRIMITIVES = [
    "peghole.dat", "axlehole.dat", "pin.dat", "axle.dat", "halfpin.dat"
]

# 连接摩擦件前缀 — 在插销类零件中定义摩擦连接段的几何原件
# 它们的放置位置即为 peg 端口，其旋转矩阵编码了插入轴方向
CONNECTOR_PREFIXES = ["confric"]

# 位置去重容差 (SI 单位, 约 1 LDU)
PORT_DEDUP_TOLERANCE = 0.0005

class ConnectionPort:
    """定义并储存装配组件的端口对象及拓扑。"""
    
    def __init__(self, port_type: str, position: np.ndarray, rotation: np.ndarray):
        """
        :param port_type: 端口类型, 例如 'peghole.dat'
        :param position: (SI 单位) 位移向量 [x, y, z]
        :param rotation: 3x3 旋转矩阵 [ [R00, R01, R02], [R10, R11, R12], [R20, R21, R22] ]
        """
        self.port_type = port_type
        self.position = position
        self.rotation = rotation

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.port_type,
            "position": self.position.tolist(),
            "rotation": self.rotation.tolist()
        }

class PhysicsProperties:
    """存储计算后的刚体物理属性模型。"""
    
    def __init__(self, mass: float, com: np.ndarray, inertia: np.ndarray, colliders: List[trimesh.Trimesh]):
        self.mass = mass
        self.com = com            # [x, y, z] 质心位置
        self.inertia = inertia    # 3x3 惯性张量阵列
        self.colliders = colliders  # VHACD 产生的复杂多重凸碰撞体

    def summary(self) -> Dict[str, Any]:
        return {
            "mass": self.mass,
            "center_of_mass": self.com.tolist(),
            "inertia_tensor": self.inertia.tolist(),
            "collider_count": len(self.colliders)
        }

class LDrawParser:
    """
    负责提取和管理 LEGO LDraw 物体属性。包含:
    - 读取并过滤 .dat 文件里的子元件；
    - 针对 LDraw 的结构缩放进行 LDU -> SI 转换；
    - 执行质量估算以及提取复杂的多块 V-HACD 碰撞体。
    """
    
    def __init__(self, ldraw_path: str = "ldraw_lib"):
        self.ldraw_path = ldraw_path
        self.parts_path = os.path.join(ldraw_path, "parts")
        self.p_path = os.path.join(ldraw_path, "p")
        self.ports: List[ConnectionPort] = []
        self.fallback_data: Dict[str, Any] = {}
        
        if not os.path.exists(ldraw_path):
            logger.warning(f"LDraw 库路径不存在: {ldraw_path}，解析功能受限。")

    def resolve_path(self, filename: str) -> Optional[str]:
        """根据 LDraw 规则寻找文件的绝对路径。"""
        # 统一使用正斜杠并规范化
        filename = filename.lower().replace('\\', '/')
        
        # 1. 尝试直接作为相对路径拼接
        full_path = os.path.normpath(os.path.join(self.ldraw_path, filename))
        if os.path.exists(full_path):
            return full_path

        # 2. 如果文件名包含 s/ 或 48/，尝试在 parts 和 p 下查找
        search_roots = [self.parts_path, self.p_path]
        for root in search_roots:
            full_path = os.path.normpath(os.path.join(root, filename))
            if os.path.exists(full_path):
                return full_path

        # 3. 基础搜索路径 (针对不带子目录的文件)
        search_dirs = [
            self.parts_path,
            self.p_path,
            os.path.join(self.parts_path, "s"),
            os.path.join(self.p_path, "48")
        ]
        
        file_basename = os.path.basename(filename)
        for d in search_dirs:
            full_path = os.path.normpath(os.path.join(d, file_basename))
            if os.path.exists(full_path):
                return full_path
            
        return None

    def load_fallback_json(self, filepath: str) -> None:
        """为缺乏规则端口或结构受损的部件加载手工标记的连接拓扑 (JSON)"""
        if not os.path.exists(filepath):
            logger.error(f"Fallback JSON 路径尚未找到: {filepath}")
            return
            
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                self.fallback_data = json.load(f)
                logger.info(f"成功注入 Fallback 补偿字典: {filepath}")
        except Exception as e:
            logger.error(f"解析 JSON 出错 {filepath}: {e}")

    def parse_dat_file(self, filename: str, recursive: bool = True, transform: np.ndarray = np.eye(4)) -> List[ConnectionPort]:
        """
        检索 .dat 文本并抽取其中的指定孔/突起端口元件位置。
        :param filename: 文件名或路径
        :param recursive: 是否递归解析子部件
        :param transform: 当前积累的变换矩阵 (4x4)
        """
        # 统一清理文件名
        filename = filename.strip().lower().replace('\\', '/')
        
        # 路径解析
        filepath = self.resolve_path(filename)

        if not filepath:
            # 只有当这不是常见的子原件时才发出警告，减少噪音
            if not any(x in filename for x in ['stud', 'rect', 'edge']):
                logger.warning(f"解析警告: 库中未找到 {filename}")
            return []

        local_ports = []
        
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            logger.error(f"读取文件失败 {filepath}: {e}")
            return []

        for line_num, line in enumerate(lines, 1):
            parts = line.strip().split()
            if not parts:
                continue

            # Type 1 指令: 1 <colour> x y z a b c d e f g h i <file>
            if parts[0] == '1' and len(parts) >= 15:
                child_file = parts[-1].lower()
                
                try:
                    # 提炼局部变换
                    x, y, z = map(float, parts[2:5])
                    a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
                    
                    # 构造局部变换矩阵 (4x4)
                    local_mat = np.array([
                        [a, b, c, x],
                        [d, e, f, y],
                        [g, h, i, z],
                        [0, 0, 0, 1]
                    ])
                    
                    # 累积全局变换
                    global_mat = transform @ local_mat
                    
                    # 判断子文件是否为语义端口或连接器件
                    is_semantic = any(prim in child_file for prim in SEMANTIC_PRIMITIVES)
                    child_basename = os.path.basename(child_file).split('.')[0]
                    is_connector = any(child_basename.startswith(pfx) for pfx in CONNECTOR_PREFIXES)

                    if is_semantic or is_connector:
                        pos_ldu = global_mat[:3, 3]
                        rot_mat = global_mat[:3, :3]
                        port_type = child_file if is_semantic else "peg"
                        
                        local_ports.append(ConnectionPort(
                            port_type=port_type, 
                            position=pos_ldu * LDU_TO_SI, 
                            rotation=rot_mat
                        ))
                    
                    elif recursive:
                        local_ports.extend(self.parse_dat_file(child_file, recursive=True, transform=global_mat))
                        
                except ValueError:
                    logger.warning(f"丢弃 {filepath} 第 {line_num} 行，内部坐标转换失败。")

        # 处理 Fallback 数据 (仅在根调用时或针对特定文件名)
        part_name = os.path.basename(filepath)
        if part_name in self.fallback_data:
            manual_ports = self.fallback_data[part_name].get("ports", [])
            for mp in manual_ports:
                pos_ldu = np.array(mp.get("position", [0.0, 0.0, 0.0]))
                pos_global = (transform @ np.append(pos_ldu, 1.0))[:3]
                rot_local = np.array(mp.get("rotation", np.eye(3).tolist()))
                rot_global = transform[:3, :3] @ rot_local
                
                p_type = mp.get("type", "manual_fallback.dat")
                local_ports.append(ConnectionPort(port_type=p_type, position=pos_global * LDU_TO_SI, rotation=rot_global))

        # 位置去重：同一位置的多个原件（如同一连接段的多个 confric）只保留一个端口
        local_ports = self._deduplicate_ports(local_ports)
                
        return local_ports

    @staticmethod
    def _deduplicate_ports(ports: List['ConnectionPort']) -> List['ConnectionPort']:
        """按位置去重，同一位置（容差内）的多个端口只保留第一个。"""
        if len(ports) <= 1:
            return ports
        
        unique: List[ConnectionPort] = []
        for port in ports:
            is_dup = False
            for existing in unique:
                dist = np.linalg.norm(port.position - existing.position)
                if dist < PORT_DEDUP_TOLERANCE:
                    is_dup = True
                    break
            if not is_dup:
                unique.append(port)
        
        if len(unique) < len(ports):
            logger.info(f"端口去重: {len(ports)} -> {len(unique)}")
        
        return unique

    def compute_physics(self, mesh_filepath: str) -> Optional[PhysicsProperties]:
        """
        引入高模网格使用，配置材质特征计算出用于之后导入 PyBullet 或 MuJoCo 的核心物理性质，
        再进一步通过基于 V-HACD 近似的凸包重置建立用于性能和准确度更平衡的 `<collision>` 多边形网格组。
        """
        if not os.path.exists(mesh_filepath):
            logger.error(f"指定的用来计算物理网格数据的路径不存在: {mesh_filepath}")
            return None

        try:
            # 加载 mesh
            mesh = trimesh.load(mesh_filepath, force='mesh')
            
            # 引入密度的量级 (ABS)
            mesh.density = ABS_DENSITY
            
            # 使用基于体积和密度的接口生成各项力学及刚体重心值
            mass = mesh.mass
            com = mesh.center_mass
            # inertia 是相对于网格原点的 3x3 矩阵，一般在 URDF 引用之前必须校正或者转移
            inertia = mesh.moment_inertia

            logger.info("向后台 V-HACD 引擎递交凸面细拆运算...")
            # V-HACD 凸包重置
            try:
                # trimesh 的 v-hacd 解析实现 (会调用系统的 TestVHACD 执行环境)
                hulls = trimesh.decomposition.convex_decomposition(mesh)
                # 转换输出保持统一 List 形式，即便其只有一个网格片段。
                colliders = hulls if isinstance(hulls, list) else [hulls]
            except Exception as vhacd_err:
                logger.warning(f"V-HACD 无法调用或发生错误，回落至单一全局凸包生成替代: {vhacd_err}")
                colliders = [mesh.convex_hull]
            
            logger.info(f"刚体物理计算完成，切片数: {len(colliders)}，总质量估值: {mass:.5f} kg。")
            
            return PhysicsProperties(mass=mass, com=com, inertia=inertia, colliders=colliders)
        
        except Exception as e:
            logger.error(f"处理 Trimesh 网格及其物理属性遇到了灾难级崩溃: {e}")
            return None


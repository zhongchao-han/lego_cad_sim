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
    
    def __init__(self):
        self.ports: List[ConnectionPort] = []
        self.fallback_data: Dict[str, Any] = {}

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

    def parse_dat_file(self, filepath: str) -> List[ConnectionPort]:
        """
        检索 .dat 文本并抽取其中的指定孔/突起端口元件位置。
        返回标准化 (SI 单位) 以及含有正确朝向矩阵的集合对象。
        """
        self.ports.clear()
        
        if not os.path.exists(filepath):
            logger.error(f"未找到目标可读取的原型 .dat 数据文件: {filepath}")
            return []

        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()

        for line_num, line in enumerate(lines, 1):
            parts = line.strip().split()
            if not parts:
                continue

            # Type 1 指令格式为:
            # 1 <colour> x y z a b c d e f g h i <file>
            if parts[0] == '1' and len(parts) >= 15:
                child_file = parts[-1].lower()
                
                # Check for semantically meaningful pinholes and connectors
                if any(prim in child_file for prim in SEMANTIC_PRIMITIVES):
                    try:
                        # 提炼平移向量并使用比例运算以完成从 LDU 转换至 SI 机制 (米)。
                        x, y, z = map(float, parts[2:5])
                        position = np.array([x, y, z]) * LDU_TO_SI
                        
                        # 提炼旋转矩阵的参数
                        a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
                        # 按行组合构造 3x3 NumPy ndarray 对象:
                        rotation = np.array([
                            [a, b, c],
                            [d, e, f],
                            [g, h, i]
                        ])
                        
                        self.ports.append(ConnectionPort(
                            port_type=child_file, 
                            position=position, 
                            rotation=rotation
                        ))
                    except ValueError:
                        logger.warning(f"丢弃第 {line_num} 行，内部坐标转换过程中失败...")
        
        # 覆写与扩展使用 Fallback 定向策略
        part_name = os.path.basename(filepath)
        if part_name in self.fallback_data:
            manual_ports = self.fallback_data[part_name].get("ports", [])
            for mp in manual_ports:
                # 容许传入预先以 SI 给出的或未放缩过的坐标配置，此例默认转换。
                pos = np.array(mp.get("position", [0.0, 0.0, 0.0])) * LDU_TO_SI
                rot = np.array(mp.get("rotation", np.eye(3).tolist()))
                p_type = mp.get("type", "manual_fallback.dat")
                self.ports.append(ConnectionPort(port_type=p_type, position=pos, rotation=rot))
                
        logger.info(f"[LDraw 语义解析分析]: {filepath} 解析完毕，共寻找到 {len(self.ports)} 节点端口.")
        return self.ports

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

# =========================== Unit testing execution ============================
if __name__ == "__main__":
    # --- 开发验证和测试桩环境设定 ---
    # 用创建并测试基础虚拟 LDraw 格式来推行单位与数学行为的准确程度
    test_dat_path = "mock_part.dat"
    test_json_path = "fallback.json"
    
    with open(test_dat_path, "w", encoding='utf-8') as f:
        f.write("0 Mock Technic Beam 1x3\n")
        f.write("1 16 0 0 0 1 0 0 0 1 0 0 0 1 peghole.dat\n")
        # 横坐标 20 等同于 20 * 0.0004 = 0.008M
        f.write("1 16 20 0 0 1 0 0 0 1 0 0 0 1 peghole.dat\n")
        f.write("1 16 -20 0 0 1 0 0 0 1 0 0 0 1 axlehole.dat\n")

    fallback_payload = {
        test_dat_path: {
            "ports": [
                {
                    "type": "custom_pin.dat",
                    "position": [40, 0, 0], 
                    "rotation": [[1,0,0], [0,1,0], [0,0,1]]
                }
            ]
        }
    }
    with open(test_json_path, "w", encoding='utf-8') as f:
        json.dump(fallback_payload, f)
        
    parser = LDrawParser()
    parser.load_fallback_json(test_json_path)
    
    print("\n--- LEGO 核心解析数据调试及正确度校验 ---")
    ports = parser.parse_dat_file(test_dat_path)
    for p in ports:
        print(p.to_dict())

    os.remove(test_dat_path)
    os.remove(test_json_path)

    print("\n[Phase 1 数据管线就绪，等待向外输出并联用。]")

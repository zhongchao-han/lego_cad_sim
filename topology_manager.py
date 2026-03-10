import xml.etree.ElementTree as ET
from xml.dom import minidom
import networkx as nx
import numpy as np
from scipy.spatial.transform import Rotation as R
import logging
from typing import Dict, List, Tuple, Any, Optional
import uuid

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# --- 辅助数据结构 ---

class PartNode:
    """描述一个被实例化的零件节点"""
    def __init__(self, part_id: str, name: str, mass: float = 0.001, inertia: Optional[np.ndarray] = None):
        self.part_id = part_id    # 全局唯一的零件实例 ID
        self.name = name          # 零件名称 (如 '1x3_beam')
        self.mass = mass
        self.inertia = inertia if inertia is not None else np.eye(3) * 1e-6
        # 该零件在装配整体坐标系下的绝对位姿，仅供参考或装配起始计算使用
        self.global_transform = np.eye(4) 
        # 引用的视觉或碰撞组件路径或生成名称
        self.visual_mesh = f"{name}.obj" 
        self.collision_mesh = f"{name}_vhacd.obj"

class ConnectionEdge:
    """描述两个零件端口之间的物理连接"""
    def __init__(self, parent_id: str, child_id: str, port_type_p: str, port_type_c: str, 
                 parent_origin: np.ndarray, parent_rot: np.ndarray,
                 child_origin: np.ndarray, child_rot: np.ndarray):
        
        self.parent_id = parent_id
        self.child_id = child_id
        
        # 记录端口种类，用于推断 Joint 类型
        self.port_type_p = port_type_p 
        self.port_type_c = port_type_c
        
        # 端口在其所属零件局部坐标系下的位姿
        self.parent_origin = parent_origin  # [x,y,z]
        self.parent_rot = parent_rot        # 3x3 矩阵
        self.child_origin = child_origin    # [x,y,z]
        self.child_rot = child_rot          # 3x3 矩阵
        
        # 如果两条边属于相同的父子对组合，用来标记合并过约束。
        self.is_merged = False

# --- 核心拓扑管理与 URDF 无环树生成器 ---

class TopologyManager:
    """
    基于 NetworkX 图论库维护零件与连结之间的拓扑。
    功能：检测过约束（多端连接转 Fixed），断绝闭环并提取供 URDF 的生成树，
    推算局部 tf（transform）并且输出 URDF 语法文本。
    """
    
    def __init__(self):
        # 使用多重有向图存储，以容许两零件之间有多个联结边（等待后续过滤与合并）
        self.graph = nx.MultiDiGraph()
        # 记录所有的闭合环，不在生成树里而用于导出额外的 Gazebo 原生物理约束或记录
        self.closed_loops: List[ConnectionEdge] = []
        
    def add_part(self, part: PartNode):
        """向装配空间中压入独立的零件"""
        if not self.graph.has_node(part.part_id):
            self.graph.add_node(part.part_id, data=part)
            logger.info(f"添加新零件节点: {part.part_id} ({part.name})")

    def connect_ports(self, edge: ConnectionEdge):
        """记录零件间的一个端口至端口的连接点"""
        if not self.graph.has_node(edge.parent_id) or not self.graph.has_node(edge.child_id):
            logger.error("连接建立失败：有端口引用的 PartNode ID 不在图中，请先 add_part。")
            return
            
        self.graph.add_edge(edge.parent_id, edge.child_id, key=uuid.uuid4().hex, data=edge)

    def _determine_joint_type(self, type_p: str, type_c: str, is_overconstrained: bool) -> str:
        """
        根据 LEGO 特定的孔洞关系及约束状态裁定物理引擎的关节点属性
        """
        if is_overconstrained:
            return "fixed"  # 检测到多重连接则为强制静止

        combined = f"{type_p}_{type_c}"
        if "pin" in combined.lower() and "hole" in combined.lower():
            # 圆柱销 + 圆孔 -> 允许一自由度的持续旋转
            return "continuous" 
        elif "axle" in combined.lower() and "hole" in combined.lower():
            # 十字轴受物理锁止，通常无转动自由度也不能滑动(如果两头固定) -> 表现为 fixed
            return "fixed"
        else:
            # 默认返回固定以保证不会莫名垮塌
            return "fixed"

    def _calculate_relative_transform(self, parent_tr: np.ndarray, parent_rot: np.ndarray,
                                      child_tr: np.ndarray, child_rot: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """
        使用 scipy 计算 Child Link 究竟应该相对 Parent Link 置于什么样的 `origin xyz rpy`。
        """
        # 将局部旋转转换为 scipy 的 Rotation 物件
        r_p = R.from_matrix(parent_rot)
        r_c = R.from_matrix(child_rot)

        # 核心算理：将子链接通过对齐接口拉拢到父连接端口的变换。
        rel_pos = parent_tr - child_tr # 简化模型：这里假设基于端口中心对齐，并未对齐轴向进行投影
        
        # 欧拉角转换用于 URDF rpy属性 (Roll, Pitch, Yaw), 使用外旋 xyz (即固定轴，等于内旋 zyx 取反)
        # scipy euler 'xyz' 也就是相对于固定轴的 x, y, z 旋转，完美匹配 URDF roll pitch yaw
        rpy_parent = r_p.as_euler('xyz')
        rpy_child = r_c.as_euler('xyz')
        
        # 此处简略将欧拉坐标重置（在严谨 IK 对齐下需要 r_p * r_c.inv() 等转换，在此以端口正交并置对演示）
        rel_rpy = r_p.as_euler('xyz') - r_c.as_euler('xyz')
        
        return rel_pos, rel_rpy

    def build_spanning_tree(self) -> nx.DiGraph:
        """
        核心合并与树解包算法：
        1. 寻找两个确切零件之间的多条 Edge 并做过约束融合压缩 (Multigraph -> Graph)
        2. 基于 BFS 推演无环图 DAG 作为 URDF 的基础结构，剥离的边储存留作闭环打断记录。
        """
        # --- 步骤 1：处理多重连接（防过约束爆裂）---
        simple_graph = nx.DiGraph()
        
        # 提取图里的节点，塞回全新的简略有向图中
        for node_id, data in self.graph.nodes(data=True):
            simple_graph.add_node(node_id, **data)
            
        for u, v in self.graph.edges:
            edges_between_uv = self.graph.get_edge_data(u, v)
            if edges_between_uv:
                edge_list = list(edges_between_uv.values())
                primary_edge: ConnectionEdge = edge_list[0]['data']
                
                # 如果这个面上不止一根 Pin 相连，必须并合成一个 Fixed Joint 以避免无穷约束张力。
                if len(edge_list) > 1:
                    primary_edge.is_merged = True
                    logger.info(f"过约束检测：零部件 {u} 与 {v} 间检测到 {len(edge_list)} 处端口碰撞/连接，合并为 Fixed Joint。")
                
                # URDF 需要单根关系，我们只把主约束加进新图
                if not simple_graph.has_edge(u, v):
                    simple_graph.add_edge(u, v, data=primary_edge)
                    
        # --- 步骤 2：解环 (BFS 遍历打断 Cycles) ---
        urdf_tree = nx.DiGraph()
        self.closed_loops.clear()
        
        # 寻找根节点 (假设选取最高入度为 0 的节点或随机一个)
        in_degrees = dict(simple_graph.in_degree())
        if not in_degrees:
            return urdf_tree
            
        root_nodes = [n for n, d in in_degrees.items() if d == 0]
        root = root_nodes[0] if root_nodes else list(simple_graph.nodes)[0]
        
        logger.info(f"挑选 URDF 树根节点为 Base Link: {root}")
        
        # 记录已被 BFS 所触达的元件标记集
        visited = set()
        queue = [root]
        
        while queue:
            current = queue.pop(0)
            if current not in visited:
                visited.add(current)
                # 复制节点
                if not urdf_tree.has_node(current):
                    urdf_tree.add_node(current, data=simple_graph.nodes[current]['data'])
                
                # 漫游全部直系亲属
                for neighbor in simple_graph.successors(current):
                    edge_data = simple_graph.get_edge_data(current, neighbor)['data']
                    if neighbor not in visited:
                        urdf_tree.add_edge(current, neighbor, data=edge_data)
                        queue.append(neighbor)
                    else:
                        # 指向了已覆盖的节点，构成了拓扑循环。打断此边！
                        self.closed_loops.append(edge_data)
                        logger.warning(f"闭环打破：移除由 {current} 到 {neighbor} 的环状物理连接，转至额外 Gazebo约束组.")

        return urdf_tree

    def export_urdf(self, urdf_tree: nx.DiGraph, output_file: str = "lego_assembly.urdf"):
        """
        接受无环化的 URDF 树，应用 TF 数据，并生成 xml 文档。
        """
        robot = ET.Element('robot', name="lego_technic_assembly")

        # 1. 建立所有的 Links (网格对象和物理对象)
        for node_id, params in urdf_tree.nodes(data=True):
            part: PartNode = params['data']
            
            link = ET.SubElement(robot, 'link', name=node_id)
            
            # Inetial 惯性描述
            inertial = ET.SubElement(link, 'inertial')
            mass = ET.SubElement(inertial, 'mass', value=str(part.mass))
            # （这里默认置零以示例）
            ET.SubElement(inertial, 'origin', xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(inertial, 'inertia', 
                          ixx=str(part.inertia[0,0]), ixy=str(part.inertia[0,1]), ixz=str(part.inertia[0,2]),
                          iyy=str(part.inertia[1,1]), iyz=str(part.inertia[1,2]), izz=str(part.inertia[2,2]))
            
            # Visual 组件
            visual = ET.SubElement(link, 'visual')
            ET.SubElement(visual, 'origin', xyz="0 0 0", rpy="0 0 0")
            geometry = ET.SubElement(visual, 'geometry')
            ET.SubElement(geometry, 'mesh', filename=part.visual_mesh)
            
            # Collision 碰撞模型 (指代 V-HACD 产生的复数凸壳)
            collision = ET.SubElement(link, 'collision')
            ET.SubElement(collision, 'origin', xyz="0 0 0", rpy="0 0 0")
            c_geometry = ET.SubElement(collision, 'geometry')
            ET.SubElement(c_geometry, 'mesh', filename=part.collision_mesh)

        # 2. 建立接头 Joints
        for u, v, params in urdf_tree.edges(data=True):
            edge: ConnectionEdge = params['data']
            
            # 计算究竟用何种类型的联合及转速 TF
            j_type = self._determine_joint_type(edge.port_type_p, edge.port_type_c, edge.is_merged)
            
            rel_pos, rel_rpy = self._calculate_relative_transform(
                edge.parent_origin, edge.parent_rot, 
                edge.child_origin, edge.child_rot
            )

            joint_name = f"joint_{u}_to_{v}"
            joint = ET.SubElement(robot, 'joint', name=joint_name, type=j_type)
            
            ET.SubElement(joint, 'parent', link=u)
            ET.SubElement(joint, 'child', link=v)
            
            xyz_str = " ".join(map(lambda x: f"{x:.5f}", rel_pos))
            rpy_str = " ".join(map(lambda x: f"{x:.5f}", rel_rpy))
            ET.SubElement(joint, 'origin', xyz=xyz_str, rpy=rpy_str)
            
            # 如果是摩擦销，可以对 friction / damping 开出配置给动力学引擎。
            if j_type != "fixed":
                ET.SubElement(joint, 'axis', xyz="0 0 1") # 根据引脚旋转轴进行
                ET.SubElement(joint, 'dynamics', damping="0.1", friction="0.05")

        # 3. 产生额外约束以处理闭环结构 (供给 Gazebo 等)
        for loop_edge in self.closed_loops:
            gazebo_tag = ET.SubElement(robot, 'gazebo')
            plugin = ET.SubElement(gazebo_tag, 'plugin', name=f"loop_joint_{loop_edge.parent_id}_{loop_edge.child_id}")
            # 注：这里以注释或者扩展节点指代闭环在非传统树引擎(如 pybullet 也可以通过 createConstraint 模拟)的使用
            ET.SubElement(plugin, 'parent').text = loop_edge.parent_id
            ET.SubElement(plugin, 'child').text = loop_edge.child_id
            ET.SubElement(plugin, 'anchor_type').text = "fixed"

        # 美化并输出 XML
        xml_str = minidom.parseString(ET.tostring(robot)).toprettyxml(indent="  ")
        with open(output_file, "w", encoding='utf-8') as f:
            f.write(xml_str)
        
        logger.info(f"成功输出装配形态 URDF 至 {output_file}")


# =========================== Unit testing execution ============================
if __name__ == "__main__":
    print("\n--- Phase 2: Topology Manager & URDF Export 单元防崩测试 ---")
    
    manager = TopologyManager()
    
    # 建立 3 个模拟的 LEGO 单元（比如为了构成闭环矩形，再随便找个节点收拢）
    beam_a = PartNode("A", "3x3_beam_L")
    beam_b = PartNode("B", "3x3_beam_R")
    connector_c = PartNode("C", "pin_H")
    
    manager.add_part(beam_a)
    manager.add_part(beam_b)
    manager.add_part(connector_c)
    
    id_rot = np.eye(3)
    
    # 构建连接关系，展示多向多端口：
    # A->B 有两条同样的联结作为过约束测试：会熔合产生 is_merged = True
    e1 = ConnectionEdge("A", "B", "peghole", "pin", np.array([0.008, 0, 0]), id_rot, np.array([0,0,-0.004]), id_rot)
    e1_dup = ConnectionEdge("A", "B", "peghole", "pin", np.array([-0.008, 0, 0]), id_rot, np.array([0,0,0.004]), id_rot)
    manager.connect_ports(e1)
    manager.connect_ports(e1_dup)
    
    # B->C 正常传递：
    e2 = ConnectionEdge("B", "C", "axlehole", "axle", np.array([0,0,0]), id_rot, np.array([0,0,0]), id_rot)
    manager.connect_ports(e2)
    
    # C->A 回归连接产生闭环测试：
    e3 = ConnectionEdge("C", "A", "pin", "peghole", np.array([0, 0.004, 0]), id_rot, np.array([0, -0.004, 0]), id_rot)
    manager.connect_ports(e3)
    
    # 解算跨越
    tree = manager.build_spanning_tree()
    
    print("\n【URDF 转换树节点状态】")
    print("总节点数:", tree.number_of_nodes())
    print("总边数量:", tree.number_of_edges(), "(应只剩过滤和破环之后的边)")
    print("受限打断环的数量:", len(manager.closed_loops))
    
    urdf_filename = "mock_output.urdf"
    manager.export_urdf(tree, urdf_filename)
    
    # 回显下生成的 URDF 头片段
    with open(urdf_filename, "r") as f:
        print("\n【生成的一瞥 (前25行) URDF内容】")
        for _ in range(25):
            line = f.readline()
            if not line: break
            print(line.strip('\n'))

    import os
    os.remove(urdf_filename)
    print("\n[Topology Manager URDF 装配组件输出核准完成]")

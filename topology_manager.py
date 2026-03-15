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
        
        # 物理深度和摩擦力元数据 (用于动力学优化)
        self.prismatic_limit: Optional[float] = None # 插拔行程 [m]
        self.friction_coeff: float = 0.5           # 摩擦系数

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

        # 1. 端口唯一性与换孔逻辑：一个零件的某个物理端口（child 端）在同一时间只能存在于一个孔内。
        # 如果该端口已有连接，说明用户在执行“移动/重连”操作，应删除旧连接。
        if self.graph.has_node(edge.child_id):
            # 搜索指向 child_id 的所有现有边
            in_edges = list(self.graph.in_edges(edge.child_id, data=True, keys=True))
            for u, v, key, data in in_edges:
                exist_e: ConnectionEdge = data['data']
                # 比较子端口在局部坐标系下的位置，判断是否为同一个物理接口
                if np.linalg.norm(edge.child_origin - exist_e.child_origin) < 1e-4:
                    self.graph.remove_edge(u, v, key=key)
                    logger.info(f"端口重定义：移除零件 {edge.child_id} 端口 {edge.child_origin} 的旧连接({u}->{v})")

        # 2. 几何去重：如果 parent 和 child 已经在完全一样的位置建立过连接，跳过（防止重复点击）。
        if self.graph.has_edge(edge.parent_id, edge.child_id):
            existing_edges = self.graph.get_edge_data(edge.parent_id, edge.child_id)
            for key in existing_edges:
                old_edge: ConnectionEdge = existing_edges[key]['data']
                dist_p = np.linalg.norm(edge.parent_origin - old_edge.parent_origin)
                dist_c = np.linalg.norm(edge.child_origin - old_edge.child_origin)
                if dist_p < 2e-4 and dist_c < 2e-4:
                    logger.debug("端口坐标提示重复点击，已忽略。")
                    return

        self.graph.add_edge(edge.parent_id, edge.child_id, key=uuid.uuid4().hex, data=edge)

    def _determine_joint_type(self, type_p: str, type_c: str, is_overconstrained: bool) -> str:
        """
        根据 LEGO 特定的孔洞关系及约束状态裁定物理引擎的关节点属性。
        现在支持：fixed, continuous, revolute, prismatic.
        """
        if is_overconstrained:
            return "fixed"

        tp = type_p.lower()
        tc = type_c.lower()
        combined = f"{tp}_{tc}"

        # 1. 销钉 + 圆孔 -> 允许旋转 + 允许沿轴滑动 (Prismatic + Revolute = Cylindrical)
        # 为简化，我们默认用 continuous 或 revolute，如果是插拔感强烈的则用 prismatic
        if "pin" in combined and "hole" in combined:
            return "revolute" # 销钉插入孔，允许转动
        
        # 2. 十字轴 + 十字孔 -> 锁定旋转，但允许沿轴滑动（除非有止位）
        if "axle" in combined and "hole" in combined:
            # 如果是十字孔，通常是为了传动，这里默认给 revolute 但会被物理形状限制
            # 实际上乐高十字轴在孔内是 fixed 旋转的
            return "fixed"
        
        # 3. 滑轨类语义 (如果有这类原件)
        if "slider" in combined:
            return "prismatic"

        return "fixed"

    def _get_friction_by_metadata(self, part_name: str, color_code: int = 16) -> Tuple[float, float]:
        """
        根据零件名称和颜色返回特定的摩擦力和阻尼建议值。
        返回: (friction, damping)
        """
        name = part_name.lower()
        
        # 常见 LEGO 摩擦销 (Friction Pins)
        # 2780: Pin with Friction Ridges (Black)
        # 6558: Pin 3L with Friction Ridges (Blue)
        # 4459: Pin with Friction Ridges (Black)
        if any(x in name for x in ["2780", "6558", "4459", "friction"]):
            return 2.5, 0.5 
            
        # 常见无摩擦销 (Smooth Pins)
        # 3673: Pin without Friction Ridges (Light Grey)
        # 32556: Pin 3L without Friction Ridges (Tan/Grey)
        if any(x in name for x in ["3673", "32556", "smooth"]):
            return 0.1, 0.05
            
        # 根据颜色进一步精细化 (LDraw Color Codes)
        # Black (0), Blue (1), Dark Blue (272) 往往是摩擦件
        # Grey (7), Light Grey (8), Tan (2) 往往是顺滑件
        if color_code in [0, 1, 272]:
            return 2.0, 0.4
        if color_code in [7, 8, 2]:
            return 0.05, 0.02

        return 0.5, 0.1 # 默认值


    def _calculate_relative_transform(self, parent_tr: np.ndarray, parent_rot: np.ndarray,
                                      child_tr: np.ndarray, child_rot: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """
        计算当子零件端口与父零件端口对齐时，子零件相对于父零件的位姿。
        核心公式: T_child_origin = T_parent_port @ T_child_port.inv()
        """
        # 1. 构造父端口在父零件坐标系下的 4x4 变换矩阵
        T_p_port = np.eye(4)
        T_p_port[:3, :3] = parent_rot
        T_p_port[:3, 3] = parent_tr

        # 2. 构造子端口在子零件坐标系下的 4x4 变换矩阵
        T_c_port = np.eye(4)
        T_c_port[:3, :3] = child_rot
        T_c_port[:3, 3] = child_tr

        # 3. 计算子零件原点相对于父零件原点的变换
        # 由于我们希望端口面对面贴合，通常需要对子项旋转进行 180 度翻转（绕轴线）
        # 这里的对齐逻辑取决于 LDraw 端口件（如 peghole.dat）的局部定义朝向。
        T_rel = T_p_port @ np.linalg.inv(T_c_port)

        rel_pos = T_rel[:3, 3]
        # 使用 scipy 将旋转矩阵转换为 URDF 所需的 rpy (XYZ 固定轴欧拉角)
        rel_rpy = R.from_matrix(T_rel[:3, :3]).as_euler('xyz')
        
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
                
                # 多重连接物理判定：不应只看连接数，而要看连接是否限制了原本的旋转轴。
                if len(edge_list) > 1:
                    # 检查是否所有连接点都处于同一旋转轴线上 (共轴检测)
                    is_truly_fixed = False
                    first_e = edge_list[0]['data']
                    # 获取父级参考系的轴向 (这里假设主连接轴为端口的 Y 轴)
                    axis_world = first_e.parent_rot @ np.array([0, 1, 0])
                    
                    for i in range(1, len(edge_list)):
                        curr_e = edge_list[i]['data']
                        # 两个连接点之间的连线向量
                        vec = curr_e.parent_origin - first_e.parent_origin
                        dist = np.linalg.norm(vec)
                        if dist > 5e-4: # 只有当点不重合时才有意义
                            vec_dir = vec / dist
                            # 如果两孔连线方向不平行于销钉轴线，则零件无法绕该轴转动 -> 固定。
                            if abs(np.dot(vec_dir, axis_world)) < 0.99:
                                is_truly_fixed = True
                                break
                    
                    if is_truly_fixed:
                        primary_edge.is_merged = True
                        logger.info(f"基于物理原则的过约束判定：节点 {u} 与 {v} 间的连接不共轴，判定为 Fixed。")
                    else:
                        logger.info(f"几何共轴优化：节点 {u} 与 {v} 间存在 {len(edge_list)} 个共轴连接，保持 Hinged 自由度。")
                
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
        实现刚体复合化 (Rigid Body Compounding)：将所有通过 fixed 关联的零件合并为一个单一的 Link。
        """
        robot = ET.Element('robot', name="lego_technic_assembly")

        # --- 步骤 1：识别固定零件簇 (Fixed Clusters) ---
        # 在 urdf_tree 中，找到所有 joint_type 为 fixed 的边，并构建联通分量
        fixed_graph = nx.Graph()
        fixed_graph.add_nodes_from(urdf_tree.nodes())
        for u, v, params in urdf_tree.edges(data=True):
            edge: ConnectionEdge = params['data']
            j_type = self._determine_joint_type(edge.port_type_p, edge.port_type_c, edge.is_merged)
            if j_type == "fixed":
                fixed_graph.add_edge(u, v)
        
        clusters = list(nx.connected_components(fixed_graph))
        node_to_cluster_id = {}
        cluster_id_to_root = {}
        
        for i, cluster in enumerate(clusters):
            # 找到簇中在 urdf_tree 中最靠近根的节点作为该簇的代表 (cluster_root)
            # 在拓扑树中，入度为 0 或其父节点不在本丛中的即为簇根
            c_root = None
            for node in cluster:
                preds = list(urdf_tree.predecessors(node))
                if not preds or preds[0] not in cluster:
                    c_root = node
                    break
            
            cluster_id_to_root[i] = c_root
            for node in cluster:
                node_to_cluster_id[node] = i

        # 计算簇内零件相对于簇根的变换
        node_relative_to_cluster_root = {} # {node: (pos, rpy)}
        
        for i, cluster in enumerate(clusters):
            c_root = cluster_id_to_root[i]
            node_relative_to_cluster_root[c_root] = (np.array([0,0,0]), np.array([0,0,0]))
            
            # 使用 BFS 遍历簇内节点，计算累积变换
            q = [c_root]
            visited = {c_root}
            while q:
                curr = q.pop(0)
                curr_pos, curr_rpy = node_relative_to_cluster_root[curr]
                T_curr = np.eye(4)
                T_curr[:3, :3] = R.from_euler('xyz', curr_rpy).as_matrix()
                T_curr[:3, 3] = curr_pos
                
                # 寻找簇内的邻居（在 urdf_tree 中的孩子）
                for child in urdf_tree.successors(curr):
                    if child in cluster and child not in visited:
                        edge: ConnectionEdge = urdf_tree.get_edge_data(curr, child)['data']
                        rel_pos, rel_rpy = self._calculate_relative_transform(
                            edge.parent_origin, edge.parent_rot, 
                            edge.child_origin, edge.child_rot
                        )
                        T_rel = np.eye(4)
                        T_rel[:3, :3] = R.from_euler('xyz', rel_rpy).as_matrix()
                        T_rel[:3, 3] = rel_pos
                        
                        T_child_global = T_curr @ T_rel
                        child_pos = T_child_global[:3, 3]
                        child_rpy = R.from_matrix(T_child_global[:3, :3]).as_euler('xyz')
                        
                        node_relative_to_cluster_root[child] = (child_pos, child_rpy)
                        visited.add(child)
                        q.append(child)

        # --- 步骤 2：建立复合 Links ---
        for i, cluster in enumerate(clusters):
            c_root = cluster_id_to_root[i]
            link_name = f"cluster_{i}_{c_root}"
            link = ET.SubElement(robot, 'link', name=link_name)
            
            # 对簇内所有零件进行合并
            total_mass = 0.0
            for node in cluster:
                part: PartNode = urdf_tree.nodes[node]['data']
                pos, rpy = node_relative_to_cluster_root[node]
                xyz_str = " ".join(map(lambda x: f"{x:.5f}", pos))
                rpy_str = " ".join(map(lambda x: f"{x:.5f}", rpy))
                
                total_mass += part.mass
                
                # Visual
                visual = ET.SubElement(link, 'visual')
                ET.SubElement(visual, 'origin', xyz=xyz_str, rpy=rpy_str)
                geometry = ET.SubElement(visual, 'geometry')
                ET.SubElement(geometry, 'mesh', filename=part.visual_mesh)
                
                # Collision
                collision = ET.SubElement(link, 'collision')
                ET.SubElement(collision, 'origin', xyz=xyz_str, rpy=rpy_str)
                c_geometry = ET.SubElement(collision, 'geometry')
                ET.SubElement(c_geometry, 'mesh', filename=part.collision_mesh)

            # 简化的惯性组件 (可以更精确地计算质心，这里暂时取簇根原点)
            inertial = ET.SubElement(link, 'inertial')
            ET.SubElement(inertial, 'mass', value=str(total_mass))
            ET.SubElement(inertial, 'origin', xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(inertial, 'inertia', ixx="1e-3", ixy="0", ixz="0", iyy="1e-3", iyz="0", izz="1e-3")

        # --- 步骤 3：建立簇间 Joints ---
        for u, v, params in urdf_tree.edges(data=True):
            edge: ConnectionEdge = params['data']
            j_type = self._determine_joint_type(edge.port_type_p, edge.port_type_c, edge.is_merged)
            
            if j_type == "fixed":
                continue # 已在复合 link 中处理
            
            # 找到 u 和 v 分属的簇
            cid_u = node_to_cluster_id[u]
            cid_v = node_to_cluster_id[v]
            
            root_u = cluster_id_to_root[cid_u]
            root_v = cluster_id_to_root[cid_v]
            
            # 计算连接点相对于各自簇根的变换
            pos_u_in_root, rpy_u_in_root = node_relative_to_cluster_root[u]
            pos_v_in_root, rpy_v_in_root = node_relative_to_cluster_root[v]
            
            T_u_to_root = np.eye(4)
            T_u_to_root[:3, :3] = R.from_euler('xyz', rpy_u_in_root).as_matrix()
            T_u_to_root[:3, 3] = pos_u_in_root
            
            T_v_to_root = np.eye(4)
            T_v_to_root[:3, :3] = R.from_euler('xyz', rpy_v_in_root).as_matrix()
            T_v_to_root[:3, 3] = pos_v_in_root
            
            # 建立 joint 坐标系：位于 u 零件的端口位置
            # URDF Joint Origin 是 child_link_origin 相对于 parent_link_origin 的变换
            # 我们需要：T_root_v_in_root_u
            
            rel_pos_uv, rel_rpy_uv = self._calculate_relative_transform(
                edge.parent_origin, edge.parent_rot, 
                edge.child_origin, edge.child_rot
            )
            T_rel_uv = np.eye(4)
            T_rel_uv[:3, :3] = R.from_euler('xyz', rel_rpy_uv).as_matrix()
            T_rel_uv[:3, 3] = rel_pos_uv
            
            # 公式: T_root_v_in_root_u = T_u_to_root @ T_rel_uv @ T_v_to_root.inv()
            T_joint_global = T_u_to_root @ T_rel_uv @ np.linalg.inv(T_v_to_root)
            
            joint_name = f"joint_{u}_to_{v}"
            joint = ET.SubElement(robot, 'joint', name=joint_name, type=j_type)
            ET.SubElement(joint, 'parent', link=f"cluster_{cid_u}_{root_u}")
            ET.SubElement(joint, 'child', link=f"cluster_{cid_v}_{root_v}")
            
            xyz_str = " ".join(map(lambda x: f"{x:.5f}", T_joint_global[:3, 3]))
            rpy_str = " ".join(map(lambda x: f"{x:.5f}", R.from_matrix(T_joint_global[:3, :3]).as_euler('xyz')))
            ET.SubElement(joint, 'origin', xyz=xyz_str, rpy=rpy_str)
            
            ET.SubElement(joint, 'axis', xyz="0 0 1")
            # 预估摩擦力与阻尼
            # 尝试获取零件的颜色信息进行更精准的判定
            v_part: PartNode = urdf_tree.nodes[v]['data']
            # 注意：目前的 PartNode 还没有 color_code 属性，
            # 理想情况下应该从前端或 LDraw 解析中传入。暂时 fallback。
            f_val, d_val = self._get_friction_by_metadata(v_part.name) 
            dynamics = ET.SubElement(joint, 'dynamics', damping=str(d_val), friction=str(f_val))
            
            # --- 自动关节限位优化 ---
            if j_type == "revolute":
                # 特殊零件判定：如果是转向节等，给予较小的活动范围
                if any(x in v_part.name.lower() for x in ["steering", "suspension", "joint"]):
                    ET.SubElement(joint, 'limit', lower="-0.785", upper="0.785", effort="20.0", velocity="10.0")
                else:
                    # 对于普通旋转件，默认给 ±4圈
                    ET.SubElement(joint, 'limit', lower="-25.12", upper="25.12", effort="10.0", velocity="10.0")
            elif j_type == "prismatic":
                # 根据几何检测返回的真实梁厚/插销余长设置限位
                # 典型 LEGO 销钉有效行程约为 1L (8mm)
                limit_m = edge.prismatic_limit if edge.prismatic_limit else 0.008
                ET.SubElement(joint, 'limit', lower=str(-limit_m*0.5), upper=str(limit_m*0.5), effort="50.0", velocity="1.0")

        # 4. 产生额外约束以处理闭合环路
        for loop_edge in self.closed_loops:
            cid_p = node_to_cluster_id[loop_edge.parent_id]
            cid_c = node_to_cluster_id[loop_edge.child_id]
            # 这里记录簇 ID，以便在 PhysicsEngine 中创建跨越两个 Cluster 的 Constraint
            comment = ET.Comment(f"Loop constraint between cluster_{cid_p} and cluster_{cid_c}")
            robot.append(comment)

        # 美化并输出 XML
        xml_str = minidom.parseString(ET.tostring(robot)).toprettyxml(indent="  ")
        with open(output_file, "w", encoding='utf-8') as f:
            f.write(xml_str)
        
        logger.info(f"成功输出复合化 URDF 至 {output_file}，合并零件簇数量: {len(clusters)}")



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

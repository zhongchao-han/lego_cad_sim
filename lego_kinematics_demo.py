import numpy as np
import networkx as nx
from scipy.spatial.transform import Rotation as R
import xml.etree.ElementTree as ET
from xml.dom import minidom

# MODULE: Geometry & Spatial Math Helpers
def create_tf_matrix(translation, rpy):
    """
    根据位移和欧拉角(roll, pitch, yaw)创建4x4齐次变换矩阵。
    此处使用 'xyz' (固定轴或内禀均可，根据常规URDF通常使用固定欧拉角)
    """
    T = np.eye(4)
    T[:3, :3] = R.from_euler('xyz', rpy).as_matrix()
    T[:3, 3] = translation
    return T

def tf_to_xyz_rpy(T):
    """
    分解4x4齐次矩阵为平移向量和欧拉角(rpy)
    """
    translation = T[:3, 3]
    rpy = R.from_matrix(T[:3, :3]).as_euler('xyz')
    return translation, rpy


# MODULE 3.1: Sub-components (Port and Part Data Structures)
class Port:
    """定义零件上的连接端口(如公销、母孔)"""
    def __init__(self, name, translation, rpy, port_type="hole"):
        self.name = name
        self.translation = np.array(translation)
        self.rpy = np.array(rpy)
        self.port_type = port_type
        # 局部变换矩阵 (Part原点 -> Port原点)
        self.tf = create_tf_matrix(self.translation, self.rpy)

class Part:
    """定义一个物理的乐高零件（代表一个 URDF Link）"""
    def __init__(self, part_id, name, mass=1.0, com=(0, 0, 0), inertia=np.eye(3)):
        self.id = part_id
        self.name = name
        self.mass = mass
        self.com = np.array(com)
        self.inertia = inertia
        self.ports = {}
        
    def add_port(self, port):
        self.ports[port.name] = port


# MODULE 3.2: Topology & Constraint Manager (The Brain)
class TopologyManager:
    """管理装配的拓扑结构与运动学图"""
    def __init__(self):
        # 使用多重有向图以支持两个零件之间有多个连接（虽然通常只有一棵生成树会被使用）
        self.graph = nx.MultiDiGraph()
        self.parts = {}
        self.loop_closures = []
        
    def add_part(self, part):
        self.parts[part.id] = part
        self.graph.add_node(part.id, attr=part)
        
    def connect_parts(self, parent_id, parent_port_name, child_id, child_port_name, joint_type="fixed", axis=(0, 0, 1)):
        """添加装配约束（一条边）"""
        self.graph.add_edge(parent_id, child_id, 
                            parent_port=parent_port_name,
                            child_port=child_port_name,
                            joint_type=joint_type,
                            axis=axis)
        
    def resolve_kinematic_tree(self, base_link_id):
        """
        处理“闭合运动链”问题。
        由于URDF只支持Tree结构，我们使用 BFS 建立生成树。
        非树边将被识别为环路闭合约束 (例如为 MuJoCo 提供 equality constraints)。
        """
        # 使用 BFS 生成树边路线
        # nx.bfs_edges 返回 (parent, child) 对
        edges = list(nx.bfs_edges(self.graph, source=base_link_id))
        
        tree_graph = nx.DiGraph()
        tree_graph.add_nodes_from(self.graph.nodes(data=True))
        
        tree_edges_set = set()
        for u, v in edges:
            # 取第一条边（假设优先选择）
            edge_data = self.graph[u][v][0] 
            tree_graph.add_edge(u, v, **edge_data)
            tree_edges_set.add((u, v))
            
        # 找出未被合并的剩余边，标记为闭环约束
        for u, v, key, data in self.graph.edges(keys=True, data=True):
            if (u, v) not in tree_edges_set and (v, u) not in tree_edges_set:
                self.loop_closures.append((u, v, data))
                
        return tree_graph


# MODULE 4: URDF Generator Module
class URDFGenerator:
    """根据拓扑树生成 URDF XML 字符串"""
    def __init__(self, robot_name="lego_robot"):
        self.robot_name = robot_name
        
    def generate(self, topology_manager, base_link_id):
        """主入口，传入 Topology Manager，输出 XML"""
        tree = topology_manager.resolve_kinematic_tree(base_link_id)
        
        robot = ET.Element('robot', name=self.robot_name)
        
        # --- 1. 遍历图中所有节点，生成 <link> 标签 ---
        for node_id in tree.nodes:
            part = topology_manager.parts[node_id]
            link = ET.SubElement(robot, 'link', name=part.name)
            
            # 惯性和质量 (Inertial)
            inertial = ET.SubElement(link, 'inertial')
            ET.SubElement(inertial, 'origin', xyz=f"{part.com[0]:.5f} {part.com[1]:.5f} {part.com[2]:.5f}", rpy="0 0 0")
            ET.SubElement(inertial, 'mass', value=str(part.mass))
            # 惯性张量（对称）
            ixx, iyy, izz = part.inertia[0,0], part.inertia[1,1], part.inertia[2,2]
            ixy, ixz, iyz = part.inertia[0,1], part.inertia[0,2], part.inertia[1,2]
            ET.SubElement(inertial, 'inertia', 
                          ixx=str(ixx), ixy=str(ixy), ixz=str(ixz), 
                          iyy=str(iyy), iyz=str(iyz), izz=str(izz))
            
            # 使用 Mock Geometry作为碰撞和视觉演示
            for attr_name in ['visual', 'collision']:
                elem = ET.SubElement(link, attr_name)
                ET.SubElement(elem, 'origin', xyz="0 0 0", rpy="0 0 0")
                geom = ET.SubElement(elem, 'geometry')
                # 在真实生产中，这将是 <mesh filename="...stl" />
                ET.SubElement(geom, 'box', size="0.01 0.01 0.01")
            
        # --- 2. 遍历树中的边，生成 <joint> 标签 ---
        joint_counter = 1
        for u, v, data in tree.edges(data=True):
            parent_part = topology_manager.parts[u]
            child_part = topology_manager.parts[v]
            
            parent_port = parent_part.ports[data['parent_port']]
            child_port = child_part.ports[data['child_port']]
            
            # -- TF (Transform) 核心计算 --
            # 假设装配约束要求对齐两个Port的局部坐标系
            # 父级到子级Joint的Origin实际上就是 : T_parent_link -> child_link_origin
            # T_parent_to_child = T_parent_to_parent_port * (T_child_to_child_port)^-1
            T_p_port = parent_port.tf
            T_c_port_inv = np.linalg.inv(child_port.tf)
            T_p_c = np.dot(T_p_port, T_c_port_inv)
            
            translation, rpy = tf_to_xyz_rpy(T_p_c)
            
            joint_name = f"joint_{u}_{v}_{joint_counter}"
            joint_counter += 1
            
            joint = ET.SubElement(robot, 'joint', name=joint_name, type=data['joint_type'])
            ET.SubElement(joint, 'parent', link=parent_part.name)
            ET.SubElement(joint, 'child', link=child_part.name)
            
            origin_xyz = f"{translation[0]:.5f} {translation[1]:.5f} {translation[2]:.5f}"
            origin_rpy = f"{rpy[0]:.5f} {rpy[1]:.5f} {rpy[2]:.5f}"
            ET.SubElement(joint, 'origin', xyz=origin_xyz, rpy=origin_rpy)
            
            # 关节运动学限制 (非固定关节需要添加 limit)
            if data['joint_type'] not in ['fixed']:
                axis = data.get('axis', (0,0,1))
                ET.SubElement(joint, 'axis', xyz=f"{axis[0]} {axis[1]} {axis[2]}")
                ET.SubElement(joint, 'limit', lower="-3.1415", upper="3.1415", effort="10.0", velocity="1.0")
                
        # --- 3. 注释闭环（用于后续转换到Gazebo或MujoCo的Equality Constraints） ---
        for u, v, data in topology_manager.loop_closures:
            ppart, cpart = topology_manager.parts[u], topology_manager.parts[v]
            comment_text = (f" KINEMATIC LOOP CLOSURE DETECTED: "
                            f"Connect {ppart.name}({data['parent_port']}) "
                            f"and {cpart.name}({data['child_port']}) ")
            robot.append(ET.Comment(comment_text))
            
        xml_str = ET.tostring(robot, encoding='unicode')
        dom = minidom.parseString(xml_str)
        return dom.toprettyxml(indent="  ")


# --- MOCK DATASET DENMO ---
def test_demo():
    print("="*60)
    print("Initializing Lego CAD & Sim MVP Topology Manager...")
    print("="*60)
    
    topo = TopologyManager()
    
    # [零件 1: 底盘梁 Chassis Beam 3x1]
    # LDU转国际单位等比例: 1单位乐高圆孔间距大致 8mm (0.008m)
    beam = Part(1, "chassis_beam_3x1", mass=0.010)
    beam.add_port(Port("hole_left",  [-0.008, 0, 0], [0, 0, 0]))
    beam.add_port(Port("hole_mid",   [ 0.000, 0, 0], [0, 0, 0]))
    beam.add_port(Port("hole_right", [ 0.008, 0, 0], [0, 0, 0]))
    topo.add_part(beam)
    
    # [零件 2: 中心销钉 Pin]
    # 假设Pin的中心在原点，一端往下(-Z方向)，一端往上(+Z方向)
    # 对于对齐，我们将上端的port绕X旋转180度，以象征它可以与孔"面对面"插入
    pin = Part(2, "connector_peg", mass=0.002)
    pin.add_port(Port("pin_bottom", [0, 0, -0.004], [0, 0, 0]))
    pin.add_port(Port("pin_top",    [0, 0,  0.004], [np.pi, 0, 0])) 
    topo.add_part(pin)
    
    # [零件 3: 摆臂 Swing Arm 2x1]
    arm = Part(3, "swing_arm_2x1", mass=0.005)
    arm.add_port(Port("hole_base", [0, 0, 0], [0, 0, 0]))
    arm.add_port(Port("hole_tip",  [0.008, 0, 0], [0, 0, 0]))
    topo.add_part(arm)
    
    # --- 建立拓扑连接图 ---
    print("=> 1/4 构建有向无环图并连接装配端口。")
    # Beam的 hole_right 连接到 Pin 的 pin_bottom，我们选择相对刚性连接 ("fixed")
    topo.connect_parts(parent_id=1, parent_port_name="hole_right",
                       child_id=2,  child_port_name="pin_bottom", 
                       joint_type="fixed")
    
    # Pin 的 pin_top 连接到 Arm 的 hole_base，充当铰接点允许转动 ("revolute"/"continuous")
    topo.connect_parts(parent_id=2, parent_port_name="pin_top",
                       child_id=3,  child_port_name="hole_base",
                       joint_type="continuous", axis=(0, 0, 1))
                       
    # [额外测试: 模拟闭合运动学环]
    print("=> 2/4 添加冗余回环测试。")
    pin2 = Part(4, "connector_peg_2", mass=0.002)
    pin2.add_port(Port("pin_bottom", [0, 0, -0.004], [0, 0, 0]))
    pin2.add_port(Port("pin_top",    [0, 0,  0.004], [np.pi, 0, 0]))
    topo.add_part(pin2)
    
    topo.connect_parts(1, "hole_left", 4, "pin_bottom", joint_type="fixed")
    topo.connect_parts(4, "pin_top", 3, "hole_tip", joint_type="continuous") # 这个连接将会构成环路!

    print("=> 3/4 求解运动路径，提取生成树...")
    generator = URDFGenerator("lego_technic_assembly")
    
    print("=> 4/4 导出为标准 URDF...")
    # Base link 为底盘梁 (id=1)
    urdf_string = generator.generate(topo, base_link_id=1)
    
    print("\n[ RESULTING URDF ]\n")
    print(urdf_string)

if __name__ == "__main__":
    test_demo()

import networkx as nx
import numpy as np
from scipy.spatial.transform import Rotation as R
import logging
from typing import List, Set, Tuple, Optional
import uuid

from backend.auto_latch_scanner import serialize_port_key
from backend.port import Port
from backend.connection_edge import ConnectionEdge
from backend.urdf_exporter import URDFExporter

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# --- 辅助数据结构 ---

class PartNode:
    """描述一个被实例化的零件节点"""
    def __init__(
        self,
        part_id: str,
        name: str,
        mass: float = 0.001,
        inertia: Optional[np.ndarray] = None,
        ldraw_id: Optional[str] = None,
    ):
        self.part_id = part_id    # 全局唯一的零件实例 ID（前端零件实例 id）
        self.name = name          # 零件名称 (如 '1x3_beam')
        # L45：可选的原始 LDraw .dat 文件名（如 "3001.dat"）；urdf_exporter 用它
        # 查 backend.category.extract_tooth_count 推齿数，决定是否给该 joint 生成
        # <mimic> 跟随。前端 snap_parts payload 在 v4.0 起携带；老调用方为 None。
        self.ldraw_id = ldraw_id
        self.mass = mass
        self.inertia = inertia if inertia is not None else np.eye(3) * 1e-6
        # 该零件在装配整体坐标系下的绝对位姿，仅供参考或装配起始计算使用
        self.global_transform = np.eye(4)
        # 引用的视觉或碰撞组件路径或生成名称
        self.visual_mesh = f"{name}.obj"
        self.collision_mesh = f"{name}_vhacd.obj"

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

    def batch_connect(self, edges: List[ConnectionEdge]) -> int:
        """
        幂等性批量注册连接边。仅注册目标节点已存在于图中的连接。

        Args:
            edges: 由 AutoLatchScanner 发现的 ConnectionEdge 列表。

        Returns:
            实际成功注册的边数量。
        """
        logger.debug(f"[DEBUG] batch_connect: 尝试注册 {len(edges)} 条自动发现边。")
        success_count = 0
        for edge in edges:
            if not self.graph.has_node(edge.parent_id):
                logger.warning(
                    f"[AutoLatch] 跳过边: 父节点 {edge.parent_id!r} 不在图中，忽略。"
                )
                continue
            if not self.graph.has_node(edge.child_id):
                logger.warning(
                    f"[AutoLatch] 跳过边: 子节点 {edge.child_id!r} 不在图中，忽略。"
                )
                continue
            self.graph.add_edge(edge.parent_id, edge.child_id, key=uuid.uuid4().hex, data=edge)
            success_count += 1
            logger.info(
                f"[AutoLatch] 注册: {edge.parent_id} ↔ {edge.child_id} "
                f"({edge.port_parent.port_type} ↔ {edge.port_child.port_type})"
            )
        logger.debug(f"[DEBUG] batch_connect: 成功注册 {success_count} 条边。")
        return success_count

    # ── 派生视图：占用 / 可用 port (走法 A 期 A1) ────────────────────────────
    def get_occupied_port_keys(self, part_id: str) -> Set[str]:
        """返回该零件上被任何 ConnectionEdge 占用的 port key 集合。

        key 格式跟前端 ``store.ts portKey()`` 与 ``auto_latch_scanner.serialize_port_key``
        逐字符一致 ``"x.xxxx,y.yyyy,z.zzzz|nx.xx,ny.yy,nz.zz"``，让前后端能用同一
        命名空间索引。

        语义：MultiDiGraph 里 part_id 作为父节点的 out-edges 取 ``port_parent``，
        作为子节点的 in-edges 取 ``port_child`` —— 两侧都有可能在 part_id 上落
        port 占用。

        callsite 自己做减集合 ``free = sites_ports_keys - occupied_keys`` 派生
        free_ports；本类不再持有 sites 数据，避免跟 port_lib_manager 强耦合。

        Args:
            part_id: 零件实例 ID。不在 graph 中时返空集（不抛）。

        Returns:
            Set[str]: 已占用 port key 集合。无连接时返空。
        """
        keys: Set[str] = set()
        if part_id not in self.graph:
            return keys
        # part_id 作 parent: port_parent.position/rotation 是 part_id 上的 port
        edge: ConnectionEdge
        for _u, _v, data in self.graph.out_edges(part_id, data=True):
            edge = data["data"]
            keys.add(serialize_port_key(edge.port_parent.position, edge.port_parent.rotation))
        # part_id 作 child: port_child 同理
        for _u, _v, data in self.graph.in_edges(part_id, data=True):
            edge = data["data"]
            keys.add(serialize_port_key(edge.port_child.position, edge.port_child.rotation))
        return keys

    def _derive_joint(self, edge: "ConnectionEdge") -> Tuple[str, float, float]:
        """
        由 edge 中的 Port 对象推导 URDF 关节类型及物理阻尼参数。
        委托给 Port.derive_joint()，不再含有任何字符串猜测逻辑。

        Returns:
            (joint_type, damping, friction_torque)
        """
        return edge.port_parent.derive_joint(edge.port_child, edge.is_merged)

    def _calc_rel_transform(self, edge: "ConnectionEdge") -> Tuple[np.ndarray, np.ndarray]:
        """
        计算子零件原点相对于父零件坐标系的位姿（rel_pos, rel_rpy）。

        因 Port 已将 Z 轴统一为插入方向，Port.calculate_relative_transform()
        内含正确的 180° 翻转（Z 反向对扣），此处直接委托即可，无需手动猜测轴向。
        """
        T_rel   = edge.port_parent.calculate_relative_transform(edge.port_child)
        rel_pos = T_rel[:3, 3]
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
            
        for u, v in set((u, v) for u, v, _ in self.graph.edges):
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
                        # L45 修：显式 add_node 携带 PartNode data —— add_edge 会以
                        # 无属性方式自动创建 neighbor 节点，导致非 root 节点的 PartNode
                        # 数据全部丢失（pre-existing bug，被旧 link export 的 getattr
                        # 默认值掩盖；urdf_exporter 现在要靠 ldraw_id 检测齿轮，必须修）
                        if not urdf_tree.has_node(neighbor):
                            urdf_tree.add_node(neighbor, data=simple_graph.nodes[neighbor]['data'])
                        urdf_tree.add_edge(current, neighbor, data=edge_data)
                        queue.append(neighbor)
                    else:
                        # 指向了已覆盖的节点，构成了拓扑循环。打断此边！
                        self.closed_loops.append(edge_data)
                        logger.warning(f"闭环打破：移除由 {current} 到 {neighbor} 的环状物理连接，转至额外 Gazebo约束组.")

        return urdf_tree

    def export_urdf(
        self,
        urdf_tree: nx.DiGraph,
        output_file: str = "lego_assembly.urdf",
        ldraw_parts_dir: Optional[str] = None,
        floating_base:   bool = False,
    ):
        """
        接受无环化的 URDF 树，应用 TF 数据，并生成 xml 文档。
        实际导出工作委托给 urdf_exporter.URDFExporter。

        L45：ldraw_parts_dir 传入时启用齿轮 mimic 检测。
        L45b：floating_base=True 时给 URDF 加 world link + 根 floating joint。
        """
        URDFExporter(
            ldraw_parts_dir=ldraw_parts_dir,
            floating_base=floating_base,
        ).export(urdf_tree, self.closed_loops, output_file)


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

    # 辅助：用 Port.from_raw 构建测试端口（严谨模式）
    def mk(name, ldraw_type, pos):
        item = Port.from_raw(name, ldraw_type, np.array(pos), id_rot, part_context="TestPart")
        if item is None:
            raise ValueError(f"测试失败：无法创建类型为 {ldraw_type} 的测试端口。请在 port_semantics.py 中检查注册状况。")
        return item

    # 构建连接关系，展示多向多端口：
    # A->B 有两条同样的联结作为过约束测试：会熔合产生 is_merged = True
    e1 = ConnectionEdge("A", "B", mk("p1", "peghole", [0.008, 0, 0]),     mk("c1", "pin", [0,0,-0.004]))
    e1_dup = ConnectionEdge("A", "B", mk("p2", "peghole", [-0.008, 0, 0]), mk("c2", "pin", [0,0,0.004]))
    manager.connect_ports(e1)
    manager.connect_ports(e1_dup)

    # B->C 正常传递：
    e2 = ConnectionEdge("B", "C", mk("p", "axlehole", [0,0,0]), mk("c", "axle", [0,0,0]))
    manager.connect_ports(e2)

    # C->A 回归连接产生闭环测试：
    e3 = ConnectionEdge("C", "A", mk("p", "pin", [0, 0.004, 0]), mk("c", "peghole", [0, -0.004, 0]))
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

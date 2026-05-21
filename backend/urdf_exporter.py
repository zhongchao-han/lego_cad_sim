"""
urdf_exporter.py
================
URDFExporter — 将无环运动学树导出为 URDF 文件。

L45：闭环 + 齿轮联动增强（target spec：ROS 2 / SDF 1.9）
- 闭环边：旧版写 `<gazebo><plugin name=loop_joint_X_Y>` 是虚构格式，外部 simulator
  完全识别不出。改为 SDF 标准的 `<gazebo><joint type=fixed>` 形式 —— 这是 URDF
  的 Gazebo 扩展，加载到 Gazebo / Ignition 时被解析为额外 joint，重现闭环约束。
- 齿轮对：扫描 spanning tree 里的 continuous 关节，配合 PartNode.ldraw_id 查
  tooth_count，对几何上构成 mesh（轴线平行 + 中心距 ≈ (T₁+T₂)/2·module）的
  齿轮对，给后续齿轮的 joint 加 `<mimic joint="leader" multiplier="-T₁/T₂"/>`，
  让外部 simulator 自动锁定齿数比。多齿轮链确定性 leader 选取：lex 最小 part_id。

L45b：Floating Base（v1b）
- v1 没给 spanning tree root 加任何 incoming joint，URDF 加载到 ROS 2 / Gazebo 时
  base_link 默认坐标系是 world，等价于装配整体被钉死在 (0,0,0)。真物理仿真里
  自由装配（汽车、机械臂）应该是 6DOF 浮在世界里。
- 修法：URDFExporter(floating_base=True) 时在主 link/joint 之前 emit
  <link name="world"/> + <joint name="root_floating" type="floating"
  parent="world" child="$root"/>。默认关，调用方按场景需求开（ASSEMBLY 钉 /
  SIMULATION 浮）。PyBullet 不识 floating type 但 useFixedBase=False 已浮，不冲突。

L44b：中介齿轮链（gear locked to axle, axle spinning in beam hole）
- 真实 LEGO Technic 玩法：齿轮 axlehole 卡 axle 上 → 齿轮自身 child joint = fixed
  （CROSS+CROSS = fixed）；axle 与 beam 之间才是 continuous 的 spin。v1 的 mimic
  检测只看"child 含 tooth_count 且 child joint = continuous"，齿轮被它的 fixed
  joint 直接跳过。
- 修法：在 spanning tree 上沿 fixed 边做 union-find 求"轴向同步等价类"，每个
  cluster 的 effective spin joint = 进入它的第一条 continuous joint。同 cluster
  内的多齿轮通过 fixed 自然共转，无需 mimic；跨 cluster 的两齿轮做 mesh 几何
  检测，给 follower cluster 的 spin joint 加 <mimic> 引用 leader cluster 的
  spin joint。spanning tree root 所在的 cluster 没有 incoming continuous joint
  → 钉死状态，内部齿轮既不能做 leader 也不能做 follower，跳过。

PyBullet 的 add_closed_loop_constraint 走它自己的 createConstraint 路径，与
本模块无关 —— 即使 URDF 的闭环 joint 写法变了，PyBullet 仿真不受影响。
"""

import xml.etree.ElementTree as ET
from xml.dom import minidom
import logging
from typing import Dict, List, Optional, Tuple

import networkx as nx
import numpy as np
from scipy.spatial.transform import Rotation as R

from backend.connection_edge import ConnectionEdge
from backend.category import extract_tooth_count, get_part_name

logger = logging.getLogger(__name__)

# ─── L45 齿轮 mesh 几何常量（与 frontend/src/utils/gearMath.ts 同源）─────────
LDU_TO_M = 0.0004
LEGO_GEAR_MODULE_M = 8 * LDU_TO_M  # = 0.0032 m
GEAR_MESH_DIST_TOLERANCE_M = 0.001
GEAR_AXIS_PARALLEL_DOT = 0.999
GEAR_COAXIAL_OFFSET_M = 0.0008  # 中心距投影到 perp 平面 < 此值 = 共轴，无 mesh


def _world_axis_z(global_transform: np.ndarray) -> np.ndarray:
    """从 4x4 世界变换矩阵取局部 +Z 在世界里的方向（齿轮轴向）。"""
    return global_transform[:3, :3] @ np.array([0.0, 0.0, 1.0])


def _world_pos(global_transform: np.ndarray) -> np.ndarray:
    return global_transform[:3, 3].copy()


def _check_gear_mesh(
    pos_a: np.ndarray, axis_a: np.ndarray,
    pos_b: np.ndarray, axis_b: np.ndarray,
    tooth_a: int, tooth_b: int,
) -> bool:
    """与 frontend gearMath.checkMeshGeometry 同语义：轴线平行 + 中心距匹配。"""
    if abs(np.dot(axis_a, axis_b)) < GEAR_AXIS_PARALLEL_DOT:
        return False
    los = pos_b - pos_a
    along_axis = float(np.dot(los, axis_a))
    perp = los - axis_a * along_axis
    planar_dist = float(np.linalg.norm(perp))
    if planar_dist < GEAR_COAXIAL_OFFSET_M:
        return False  # 共轴
    if abs(along_axis) > LEGO_GEAR_MODULE_M:
        return False  # 沿轴向错位太多
    expected = (tooth_a + tooth_b) / 2 * LEGO_GEAR_MODULE_M
    return abs(planar_dist - expected) <= GEAR_MESH_DIST_TOLERANCE_M


class URDFExporter:
    """
    将无环运动学树（nx.DiGraph）导出为合规的 URDF XML。

    使用方式::

        exporter = URDFExporter(ldraw_parts_dir="/path/to/ldraw/parts")
        exporter.export(urdf_tree, closed_loops, "output.urdf")

    Args:
        ldraw_parts_dir: 用于查 .dat 首行解析齿数。None 时跳过齿轮 mimic 检测，
                        其它流程不受影响（向后兼容旧调用方）。
        floating_base:   L45b：True 时在 URDF 头 emit <link name="world"/> + 根
                        floating joint，让外部 simulator 视装配为 6DOF 浮空体。
                        默认 False，保持向后兼容（调用方按 ASSEMBLY/SIMULATION
                        场景自行开关）。
    """

    def __init__(
        self,
        ldraw_parts_dir: Optional[str] = None,
        floating_base:   bool = False,
    ):
        self.ldraw_parts_dir = ldraw_parts_dir
        self.floating_base   = floating_base

    def export(
        self,
        urdf_tree:    nx.DiGraph,
        closed_loops: List[ConnectionEdge],
        output_file:  str = "lego_assembly.urdf",
        robot_name:   str = "lego_technic_assembly",
    ) -> None:
        """生成 URDF 文件。"""
        robot = ET.Element('robot', name=robot_name)

        # ── 0. L45b Floating Base：world link + 根 floating joint（如启用）─────
        # URDF 规范要求引用前定义，world link 必须在 spanning tree links 之前 emit。
        # spanning tree root = 入度 0 节点（树结构保证唯一）；空树 / 多 root 时跳过。
        if self.floating_base:
            roots = [n for n in urdf_tree.nodes if urdf_tree.in_degree(n) == 0]
            if len(roots) == 1:
                root_node = roots[0]
                ET.SubElement(robot, 'link', name='world')
                fl_joint = ET.SubElement(
                    robot, 'joint', name='root_floating', type='floating',
                )
                ET.SubElement(fl_joint, 'parent', link='world')
                ET.SubElement(fl_joint, 'child',  link=root_node)
            elif roots:
                logger.warning(
                    f"[L45b] floating_base 跳过：spanning tree 检测到 {len(roots)} 个 "
                    f"入度 0 节点，无法唯一确定 root。"
                )

        # ── 1. Links ─────────────────────────────────────────────────────────
        for node_id, params in urdf_tree.nodes(data=True):
            part_data = params.get('data')

            mass_val       = getattr(part_data, 'mass',    0.001)
            inertia_mat    = getattr(part_data, 'inertia', np.eye(3) * 1e-6)
            visual_mesh    = getattr(part_data, 'visual_mesh',    f"{node_id}.obj")
            collision_mesh = getattr(part_data, 'collision_mesh', f"{node_id}_vhacd.obj")

            link = ET.SubElement(robot, 'link', name=node_id)

            inertial = ET.SubElement(link, 'inertial')
            ET.SubElement(inertial, 'mass', value=str(mass_val))
            ET.SubElement(inertial, 'origin', xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(inertial, 'inertia',
                          ixx=str(inertia_mat[0, 0]), ixy=str(inertia_mat[0, 1]),
                          ixz=str(inertia_mat[0, 2]), iyy=str(inertia_mat[1, 1]),
                          iyz=str(inertia_mat[1, 2]), izz=str(inertia_mat[2, 2]))

            visual = ET.SubElement(link, 'visual')
            ET.SubElement(visual, 'origin', xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(ET.SubElement(visual, 'geometry'), 'mesh', filename=visual_mesh)

            collision = ET.SubElement(link, 'collision')
            ET.SubElement(collision, 'origin', xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(ET.SubElement(collision, 'geometry'), 'mesh', filename=collision_mesh)

        # ── 2. Joints + L45 mimic 检测 ───────────────────────────────────────
        # 第一遍：写所有 joint，记录每条 continuous joint 的 (joint_name, child_id) 给后处理
        joint_elements: Dict[str, ET.Element] = {}  # child_id → <joint> element
        for u, v, params in urdf_tree.edges(data=True):
            edge: ConnectionEdge = params['data']

            j_type, damping, friction = edge.port_parent.derive_joint(
                edge.port_child, edge.is_merged
            )

            # 相对变换 —— 见 _emit_closed_loop_joint 同段 NOTE：depth 参数不被支持，
            # 旧 type:ignore 哄过 mypy 但运行时 TypeError，本 PR 还原原本意图。
            T_rel = edge.port_parent.calculate_relative_transform(edge.port_child)
            rel_pos = T_rel[:3, 3]
            rel_rpy = R.from_matrix(T_rel[:3, :3]).as_euler('xyz')

            joint_name = f"joint_{u}_to_{v}"
            joint = ET.SubElement(robot, 'joint', name=joint_name, type=j_type)
            ET.SubElement(joint, 'parent', link=u)
            ET.SubElement(joint, 'child',  link=v)

            xyz_str = " ".join(f"{x:.5f}" for x in rel_pos)
            rpy_str = " ".join(f"{x:.5f}" for x in rel_rpy)
            ET.SubElement(joint, 'origin', xyz=xyz_str, rpy=rpy_str)

            if j_type != "fixed":
                ET.SubElement(joint, 'axis', xyz="0 0 1")
                ET.SubElement(joint, 'dynamics',
                              damping=f"{damping:.4f}",
                              friction=f"{friction:.4f}")

            joint_elements[v] = joint

        # 第二遍：齿轮 mimic 检测（基于 PartNode.ldraw_id + global_transform）
        if self.ldraw_parts_dir:
            self._inject_gear_mimic(urdf_tree, joint_elements)

        # ── 3. 闭环 joint（SDF 1.9 / Gazebo 扩展）────────────────────────────
        # 旧版 <gazebo><plugin name=loop_joint_X_Y> 是虚构 spec，外部 simulator
        # 识别不出。改为正经 SDF <joint>，仿真 / ROS 2 加载时自动接为额外 joint。
        for loop_edge in closed_loops:
            self._emit_closed_loop_joint(robot, loop_edge)

        # ── 4. 写文件 ──────────────────────────────────────────────────────
        xml_str = minidom.parseString(ET.tostring(robot)).toprettyxml(indent="  ")
        with open(output_file, "w", encoding='utf-8') as f:
            f.write(xml_str)

        logger.info(f"URDF 已输出至 {output_file}")

    # ── L45 私有辅助 ─────────────────────────────────────────────────────────

    def _emit_closed_loop_joint(self, robot: ET.Element, edge: ConnectionEdge) -> None:
        """写 SDF 1.9 风格的闭环 joint（URDF 内嵌 Gazebo 扩展块）。"""
        # 闭环 joint 名带后缀避开与 spanning-tree joint 同名风险
        joint_name = f"loop_joint_{edge.parent_id}_to_{edge.child_id}"
        # 推导 type / 相对位姿，与正常 joint 同源逻辑（保证 simulator 端语义一致）
        j_type, _, _ = edge.port_parent.derive_joint(edge.port_child, edge.is_merged)
        # NOTE: Port.calculate_relative_transform() 不接受 depth 参数（pre-existing
        # 限制；旧代码用 type:ignore 哄过 mypy 但运行时会 TypeError）。本 PR 不修
        # 这个 bug，待 Port API 扩展时单独 issue。当前 insertion_depth 对 URDF 输出
        # 无影响 —— 与 main 上的实际跑通行为一致。
        T_rel = edge.port_parent.calculate_relative_transform(edge.port_child)
        rpy = R.from_matrix(T_rel[:3, :3]).as_euler('xyz')
        pose_xyz = " ".join(f"{x:.5f}" for x in T_rel[:3, 3])
        pose_rpy = " ".join(f"{x:.5f}" for x in rpy)

        gz = ET.SubElement(robot, 'gazebo')
        joint = ET.SubElement(gz, 'joint', name=joint_name, type=j_type)
        ET.SubElement(joint, 'parent').text = edge.parent_id
        ET.SubElement(joint, 'child').text = edge.child_id
        # SDF <pose> 是 "x y z roll pitch yaw" 单字符串
        ET.SubElement(joint, 'pose').text = f"{pose_xyz}  {pose_rpy}"
        if j_type != 'fixed':
            axis_el = ET.SubElement(joint, 'axis')
            ET.SubElement(axis_el, 'xyz').text = "0 0 1"

    def _inject_gear_mimic(
        self,
        urdf_tree: nx.DiGraph,
        joint_elements: Dict[str, ET.Element],
    ) -> None:
        """扫描齿轮对的几何 mesh，给 follower 等价类的 spin joint 加 <mimic>。

        L44b：以 spanning tree 上的 fixed 边做 union-find 求"轴向同步等价类"。
        每个 cluster 的 effective spin joint = 进入它的第一条 continuous joint。
        典型场景：齿轮 axlehole 卡 axle 上（fixed）+ axle 与 beam 之间 continuous
        旋转 → 齿轮 + axle 同 cluster，cluster 共享 axle 这条 spin。

        Mesh 几何检测复用 _check_gear_mesh（与 frontend gearMath 同源）；同 cluster
        内的多齿轮通过 fixed 自然共转，跳过；跨 cluster 配对，给 follower cluster
        的 spin joint 加 <mimic>。Leader 选择：lex 最小 part_id（多齿轮链确定）。
        Spanning tree root 所在 cluster 无 incoming continuous joint = 钉死状态，
        内部齿轮跳过（既无法做 leader 也无法做 follower）。
        """
        if not self.ldraw_parts_dir:
            return

        # ── 1. fixed-edge union-find，求轴向同步等价类 ─────────────────────
        parent_uf: Dict[str, str] = {n: n for n in urdf_tree.nodes}

        def find(x: str) -> str:
            # path compression：摊销 O(α(N))
            root = x
            while parent_uf[root] != root:
                root = parent_uf[root]
            while parent_uf[x] != root:
                parent_uf[x], x = root, parent_uf[x]
            return root

        def union(a: str, b: str) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent_uf[ra] = rb

        for u, v in urdf_tree.edges:
            joint = joint_elements.get(v)
            if joint is None:
                continue
            if joint.get('type') == 'fixed':
                union(u, v)

        # ── 2. 每个 cluster 的 effective spin joint ──────────────────────────
        # spanning tree 是树，每个非 root 节点有且仅有 1 条 incoming edge；fixed
        # 边已被 union 进同 cluster，所以每个 cluster 至多 1 条 incoming continuous
        # joint（cluster 在树中的最上端节点的那条 incoming 边）。setdefault 保留
        # 容错语义即可。
        cluster_spin_joint: Dict[str, Tuple[str, ET.Element]] = {}
        for u, v in urdf_tree.edges:
            joint = joint_elements.get(v)
            if joint is None or joint.get('type') != 'continuous':
                continue
            cluster_v = find(v)
            cluster_spin_joint.setdefault(
                cluster_v, (joint.get('name', ''), joint),
            )

        # ── 3. 收集齿轮 → 按 cluster 索引 ────────────────────────────────────
        gears: List[Tuple[str, int, np.ndarray, np.ndarray, str]] = []
        # tuple = (part_id, tooth_count, world_pos, world_axis, cluster_root)
        for n in urdf_tree.nodes:
            part_data = urdf_tree.nodes[n].get('data')
            ldraw_id = getattr(part_data, 'ldraw_id', None)
            if not ldraw_id:
                continue
            name = get_part_name(ldraw_id, self.ldraw_parts_dir)
            tooth = extract_tooth_count(name)
            if not tooth:
                continue
            T = getattr(part_data, 'global_transform', np.eye(4))
            gears.append((n, tooth, _world_pos(T), _world_axis_z(T), find(n)))

        # ── 4. 跨 cluster 配对 mesh，给 follower spin joint 加 <mimic> ───────
        followed_clusters: set[str] = set()
        gears.sort(key=lambda g: g[0])  # part_id lex 序，多齿轮链时 leader 选取确定
        for i, (_a_pid, a_tooth, a_pos, a_axis, a_cluster) in enumerate(gears):
            for j in range(i + 1, len(gears)):
                _b_pid, b_tooth, b_pos, b_axis, b_cluster = gears[j]
                # 同 cluster：FIXED 自然同步，无需 mimic
                if a_cluster == b_cluster:
                    continue
                # follower cluster 的 spin joint 已 follow 别人，避免双 mimic 元素
                if b_cluster in followed_clusters:
                    continue
                if not _check_gear_mesh(a_pos, a_axis, b_pos, b_axis, a_tooth, b_tooth):
                    continue
                # 钉死 cluster（spanning tree root 所在）无 incoming continuous joint
                a_spin = cluster_spin_joint.get(a_cluster)
                b_spin = cluster_spin_joint.get(b_cluster)
                if a_spin is None or b_spin is None:
                    continue
                a_jname, _ = a_spin
                b_jname, b_joint_el = b_spin
                # 外啮合反向：multiplier = -T_a / T_b
                multiplier = -float(a_tooth) / float(b_tooth)
                ET.SubElement(
                    b_joint_el, 'mimic',
                    joint=a_jname,
                    multiplier=f"{multiplier:.6f}",
                    offset="0",
                )
                followed_clusters.add(b_cluster)
                logger.info(
                    f"[L44b] gear mimic via cluster: {b_jname} mimics {a_jname} "
                    f"multiplier={multiplier:.4f} (T={a_tooth}↔{b_tooth})"
                )


# ---------------------------------------------------------------------------
# 模块级便捷函数
# ---------------------------------------------------------------------------

_default_exporter = URDFExporter()


def export_urdf(
    urdf_tree:    nx.DiGraph,
    closed_loops: List[ConnectionEdge],
    output_file:  str = "lego_assembly.urdf",
    robot_name:   str = "lego_technic_assembly",
    ldraw_parts_dir: Optional[str] = None,
    floating_base:   bool = False,
) -> None:
    """模块级便捷导出函数。

    Args:
        ldraw_parts_dir: 传入则启用 L44/L44b 齿轮 mimic 检测。
        floating_base:   L45b：True 时给 URDF 加 world link + 根 floating joint。
    """
    if ldraw_parts_dir or floating_base:
        exporter = URDFExporter(
            ldraw_parts_dir=ldraw_parts_dir, floating_base=floating_base,
        )
    else:
        exporter = _default_exporter
    exporter.export(urdf_tree, closed_loops, output_file, robot_name)


def floating_base_for_mode(mode: str) -> bool:
    """系统 mode → 是否给导出的 URDF 加浮空根（issue #51）。

    - ``SIMULATION`` → ``True``：整体 6DOF 浮空，符合 ROS 2 / Gazebo 物理预期
      （重力 / 外力下自由运动）。
    - ``ASSEMBLY`` / 其它 → ``False``：装配体钉死在 world，避免重力把它拉走，
      贴合本仓"装配建模 + 静力分析"主场景。

    纯函数，大小写不敏感。callsite（server.toggle_mode）据此透传 floating_base，
    替代过去无论哪个 mode 都漏传默认 False 的行为。
    """
    return (mode or "").strip().upper() == "SIMULATION"

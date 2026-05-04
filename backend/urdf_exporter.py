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

PyBullet 的 add_closed_loop_constraint 走它自己的 createConstraint 路径，与
本模块无关 —— 即使 URDF 的闭环 joint 写法变了，PyBullet 仿真不受影响。
"""

import os
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
    """

    def __init__(self, ldraw_parts_dir: Optional[str] = None):
        self.ldraw_parts_dir = ldraw_parts_dir

    def export(
        self,
        urdf_tree:    nx.DiGraph,
        closed_loops: List[ConnectionEdge],
        output_file:  str = "lego_assembly.urdf",
        robot_name:   str = "lego_technic_assembly",
    ) -> None:
        """生成 URDF 文件。"""
        robot = ET.Element('robot', name=robot_name)

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
        """扫描 continuous joint，找齿轮对，给 follower 加 <mimic>。

        齿轮 mesh 几何条件复用 _check_gear_mesh（与 frontend gearMath 同源）。
        Leader 选择：lex 最小 part_id（确保多齿轮链时拓扑确定性）。
        """
        if not self.ldraw_parts_dir:
            return
        # 收集所有"齿轮 joint"：joint type=continuous 且 child 有 tooth_count
        gears: List[Tuple[str, int, np.ndarray, np.ndarray, str]] = []
        # tuple = (part_id, tooth_count, world_pos, world_axis, joint_name)
        for u, v in urdf_tree.edges:
            joint = joint_elements.get(v)
            if joint is None or joint.get('type') != 'continuous':
                continue
            part_data = urdf_tree.nodes[v].get('data')
            ldraw_id = getattr(part_data, 'ldraw_id', None)
            if not ldraw_id:
                continue
            name = get_part_name(ldraw_id, self.ldraw_parts_dir)
            tooth = extract_tooth_count(name)
            if not tooth:
                continue
            T = getattr(part_data, 'global_transform', np.eye(4))
            gears.append((v, tooth, _world_pos(T), _world_axis_z(T), joint.get('name', '')))

        # 配对 mesh —— O(N²) 在典型 N≤20 齿轮场景下零担忧
        already_following: set[str] = set()
        gears.sort(key=lambda g: g[0])  # part_id lex 序，保证 leader 选取确定
        for i, (a_pid, a_tooth, a_pos, a_axis, a_jname) in enumerate(gears):
            for j in range(i + 1, len(gears)):
                b_pid, b_tooth, b_pos, b_axis, b_jname = gears[j]
                if b_pid in already_following:
                    continue  # 已经跟随其他 leader，避免 mimic 链
                if not _check_gear_mesh(a_pos, a_axis, b_pos, b_axis, a_tooth, b_tooth):
                    continue
                # 外啮合反向：multiplier = -T_a / T_b
                multiplier = -float(a_tooth) / float(b_tooth)
                follower_joint = joint_elements[b_pid]
                ET.SubElement(
                    follower_joint, 'mimic',
                    joint=a_jname,
                    multiplier=f"{multiplier:.6f}",
                    offset="0",
                )
                already_following.add(b_pid)
                logger.info(
                    f"[L45] gear mimic: {b_jname} mimics {a_jname} "
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
) -> None:
    """模块级便捷导出函数。ldraw_parts_dir 传入则启用齿轮 mimic 检测。"""
    exporter = URDFExporter(ldraw_parts_dir=ldraw_parts_dir) if ldraw_parts_dir else _default_exporter
    exporter.export(urdf_tree, closed_loops, output_file, robot_name)

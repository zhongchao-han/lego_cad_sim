"""
urdf_exporter.py
================
URDFExporter — 将无环运动学树导出为 URDF 文件。

从 topology_manager.py 剥离，保持 TopologyManager 的职责纯粹（图论算法）。
TopologyManager.export_urdf() 现委托至此模块，API 不变。
"""

import xml.etree.ElementTree as ET
from xml.dom import minidom
import logging
from typing import List

import networkx as nx
import numpy as np
from scipy.spatial.transform import Rotation as R

from backend.connection_edge import ConnectionEdge

logger = logging.getLogger(__name__)


class URDFExporter:
    """
    将无环运动学树（nx.DiGraph）导出为合规的 URDF XML。

    使用方式::

        exporter = URDFExporter()
        exporter.export(urdf_tree, closed_loops, "output.urdf")
    """

    def export(
        self,
        urdf_tree:    nx.DiGraph,
        closed_loops: List[ConnectionEdge],
        output_file:  str = "lego_assembly.urdf",
        robot_name:   str = "lego_technic_assembly",
    ) -> None:
        """
        生成 URDF 文件。

        Args:
            urdf_tree:    由 TopologyManager.build_spanning_tree() 或
                          Assembly.resolve_kinematics() 返回的无环有向图。
                          节点 data 字段需含 'data' 属性（PartNode 或 Part）。
            closed_loops: 被打断的闭环边列表（ConnectionEdge），用于生成
                          Gazebo 扩展约束标签。
            output_file:  输出 URDF 路径。
            robot_name:   URDF <robot> 标签的 name 属性。
        """
        robot = ET.Element('robot', name=robot_name)

        # ── 1. Links ─────────────────────────────────────────────────────────
        for node_id, params in urdf_tree.nodes(data=True):
            part_data = params.get('data')

            mass_val       = getattr(part_data, 'mass',    0.001)
            inertia_mat    = getattr(part_data, 'inertia', np.eye(3) * 1e-6)
            visual_mesh    = getattr(part_data, 'visual_mesh',    f"{node_id}.obj")
            collision_mesh = getattr(part_data, 'collision_mesh', f"{node_id}_vhacd.obj")

            link = ET.SubElement(robot, 'link', name=node_id)

            # Inertial
            inertial = ET.SubElement(link, 'inertial')
            ET.SubElement(inertial, 'mass', value=str(mass_val))
            ET.SubElement(inertial, 'origin', xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(inertial, 'inertia',
                          ixx=str(inertia_mat[0, 0]), ixy=str(inertia_mat[0, 1]),
                          ixz=str(inertia_mat[0, 2]), iyy=str(inertia_mat[1, 1]),
                          iyz=str(inertia_mat[1, 2]), izz=str(inertia_mat[2, 2]))

            # Visual
            visual = ET.SubElement(link, 'visual')
            ET.SubElement(visual, 'origin', xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(ET.SubElement(visual, 'geometry'), 'mesh', filename=visual_mesh)

            # Collision
            collision = ET.SubElement(link, 'collision')
            ET.SubElement(collision, 'origin', xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(ET.SubElement(collision, 'geometry'), 'mesh', filename=collision_mesh)

        # ── 2. Joints ─────────────────────────────────────────────────────────
        for u, v, params in urdf_tree.edges(data=True):
            edge: ConnectionEdge = params['data']

            # 关节类型及物理参数（由 Port 推导，无字符串猜测）
            j_type, damping, friction = edge.port_parent.derive_joint(
                edge.port_child, edge.is_merged
            )

            # 相对变换（含当前插入深度）
            T_rel   = edge.port_parent.calculate_relative_transform(
                edge.port_child, depth=edge.state.insertion_depth
            )
            rel_pos = T_rel[:3, 3]
            rel_rpy = R.from_matrix(T_rel[:3, :3]).as_euler('xyz')

            joint = ET.SubElement(robot, 'joint',
                                  name=f"joint_{u}_to_{v}", type=j_type)
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

        # ── 3. 闭环 Gazebo 扩展标签 ──────────────────────────────────────────
        for loop_edge in closed_loops:
            gazebo_tag = ET.SubElement(robot, 'gazebo')
            plugin = ET.SubElement(
                gazebo_tag, 'plugin',
                name=f"loop_joint_{loop_edge.parent_id}_{loop_edge.child_id}",
            )
            ET.SubElement(plugin, 'parent').text     = loop_edge.parent_id
            ET.SubElement(plugin, 'child').text      = loop_edge.child_id
            ET.SubElement(plugin, 'anchor_type').text = "fixed"

        # ── 4. 写文件 ──────────────────────────────────────────────────────
        xml_str = minidom.parseString(ET.tostring(robot)).toprettyxml(indent="  ")
        with open(output_file, "w", encoding='utf-8') as f:
            f.write(xml_str)

        logger.info(f"URDF 已输出至 {output_file}")


# ---------------------------------------------------------------------------
# 模块级便捷函数（供 topology_manager.py 委托调用）
# ---------------------------------------------------------------------------

_default_exporter = URDFExporter()


def export_urdf(
    urdf_tree:    nx.DiGraph,
    closed_loops: List[ConnectionEdge],
    output_file:  str = "lego_assembly.urdf",
    robot_name:   str = "lego_technic_assembly",
) -> None:
    """模块级便捷导出函数，等同于 URDFExporter().export(...)。"""
    _default_exporter.export(urdf_tree, closed_loops, output_file, robot_name)

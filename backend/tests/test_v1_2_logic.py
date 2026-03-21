import pytest
import numpy as np
from backend.port import Port
# 预想中的 Site 类，目前运行会报错，稍后我们会实现它
try:
    from backend.port import Site
except ImportError:
    Site = None 

def create_mock_port(name, pos, axis_z, p_type="peghole"):
    """辅助函数：创建一个模拟端口"""
    rot = np.eye(3)
    rot[:, 2] = axis_z / np.linalg.norm(axis_z)
    # 简单的正交化处理（仅用于测试）
    if abs(rot[0, 2]) < 0.9:
        rot[:, 0] = np.cross([1, 0, 0], rot[:, 2])
    else:
        rot[:, 0] = np.cross([0, 1, 0], rot[:, 2])
    rot[:, 0] /= np.linalg.norm(rot[:, 0])
    rot[:, 1] = np.cross(rot[:, 2], rot[:, 0])
    
    from backend.port_semantics import get_interface
    interface = get_interface(p_type)
    return Port(name=name, interface=interface, position=np.array(pos, dtype=float), rotation=rot, port_type=p_type)

@pytest.mark.v1_2
class TestV1_2Logic:
    """Interaction v1.2 核心逻辑测试矩阵"""

    # --- 1. Site 聚合测试 ---
    
    def test_site_clustering_basic(self):
        """测试：物理重合的两个端口是否能聚合为一个 Site"""
        p1 = create_mock_port("p1", [0, 0, 0], [0, 0, 1])
        p2 = create_mock_port("p2", [0.0001, 0, 0], [0, 0, -1]) # 0.25 LDU，应聚合
        
        # 预期的聚合逻辑调用（此时会 Fail）
        sites = Site.cluster_ports([p1, p2], threshold=1.0)
        
        assert len(sites) == 1
        assert sites[0].site_id == "site_0"
        assert len(sites[0].ports) == 2
        
    def test_site_clustering_separation(self):
        """测试：物理分离的两个孔不应聚合"""
        p1 = create_mock_port("p1", [0, 0, 0], [0, 0, 1])
        p2 = create_mock_port("p2", [20, 0, 0], [0, 0, 1]) # 标准 20 LDU 间隔
        
        sites = Site.cluster_ports([p1, p2], threshold=1.0)
        assert len(sites) == 2

    # --- 2. P2P 几何变换测试 ---

    def test_p2p_alignment_math(self):
        """测试：计算出的 P2P 变换是否能使两个端口完美重合且反向对齐"""
        source_port = create_mock_port("src", [0, 0, 0], [1, 0, 0])
        target_port = create_mock_port("tgt", [100, 50, 20], [0, 1, 0])
        
        # 计算将 source 移动到 target 的对齐矩阵
        # transform = source_port.calculate_p2p_transform(target_port)
        # 此处模拟调用
        from backend.geometry_processor import calculate_p2p_alignment # 预想中的函数
        matrix = calculate_p2p_alignment(source_port, target_port)
        
        # 应用变换到 source 端口点
        src_pos_homo = np.append(source_port.position, 1.0)
        transformed_pos = (matrix @ src_pos_homo)[:3]
        
        # 断言：位置完全重合
        np.testing.assert_allclose(transformed_pos, target_port.position, atol=1e-5)
        
        # 断言：旋转对合（Z轴反向平行）
        src_rot_world = matrix[:3, :3] @ source_port.rotation
        src_z = src_rot_world[:, 2]
        tgt_z = target_port.rotation[:, 2]
        # np.dot(src_z, tgt_z) 应为 -1.0
        assert np.isclose(np.dot(src_z, tgt_z), -1.0, atol=1e-5)

    # --- 3. 自由度 (DOF) 约束测试 ---

    def test_dof_parallel_pins(self):
        """测试：两个平行销连接梁时，应允许滑动，允许绕中心轴旋转"""
        # 模拟 ConstraintSolver.solve_dof(...)
        # TODO: 待实现核心 solver 后补齐
        pass

    def test_dof_perpendicular_pins(self):
        """测试：两个垂直销（90度）应锁死所有自由度"""
        # TODO: 待实现核心 solver 后补齐
        pass

import unittest
import numpy as np
import os
import sys

# 将当前目录加入路径以便导入模块
sys.path.append(os.getcwd())

from ldraw_parser import LDrawParser
from geometry_processor import GeometryProcessor
from topology_manager import TopologyManager, PartNode, ConnectionEdge

class TestLegoCore(unittest.TestCase):
    """
    LEGO CAD 仿真系统核心接口单元测试集
    """

    @classmethod
    def setUpClass(cls):
        cls.ldraw_path = "ldraw_lib"
        cls.parser = LDrawParser(ldraw_path=cls.ldraw_path)
        cls.processor = GeometryProcessor(ldraw_path=cls.ldraw_path)
        cls.manager = TopologyManager()

    # --- LDrawParser 接口测试 ---
    def test_parser_resolve_path(self):
        """测试 LDraw 文件路径解析接口"""
        # 测试核心库文件
        path = self.parser.resolve_path("32524.dat")
        self.assertIsNotNone(path)
        self.assertTrue(path.endswith("32524.dat"))
        
        # 测试子目录文件
        path_s = self.parser.resolve_path("s/32523s01.dat")
        self.assertIsNotNone(path_s)
        
        # 测试不存在的文件
        path_none = self.parser.resolve_path("non_existent_part.dat")
        self.assertIsNone(path_none)

    def test_parser_parse_ports(self):
        """测试零件端口（语义连接点）解析接口"""
        ports = self.parser.parse_dat_file("6558.dat") # Pin 3L
        self.assertGreater(len(ports), 0)
        # 验证端口类型
        types = [p.port_type for p in ports]
        self.assertTrue(any("peg" in t or "pin" in t for t in types))

    # --- GeometryProcessor 接口测试 ---
    def test_geometry_profile_extraction(self):
        """测试圆柱形截面轮廓提取接口（关键接口：用于插入检测）"""
        # 测试典型的销钉
        profile = self.processor.get_cross_section_profile("6558.dat", axis=0)
        self.assertIsNotNone(profile)
        self.assertIn("radii", profile)
        self.assertIn("axis_positions", profile)
        
        # 验证半径是否在合理范围内 (乐高 1L 约为 8mm, 半径约 3mm)
        # 1 LDU = 0.4mm, 8 LDU = 3.2mm
        max_r = max(profile["radii"])
        self.assertLess(max_r, 0.005) # 不应超过 5mm
        self.assertGreater(max_r, 0.002) # 不应小于 2mm

    def test_geometry_hole_radius(self):
        """测试梁孔半径自动估算接口"""
        # peghole.dat 是标准的乐高孔基准，内径 6 LDU = 2.4mm
        radius = self.processor.get_hole_radius("peghole.dat", hole_axis=1)
        self.assertIsNotNone(radius)
        # 根据实际网格提取，允许一定范围，通常在 6-8 LDU 之间判定为有效
        self.assertGreater(radius, 0.002) 
        self.assertLess(radius, 0.004)

    # --- TopologyManager 接口测试 ---
    def test_topology_tree_and_urdf(self):
        """测试拓扑管理器的树生成与 URDF 导出接口"""
        manager = TopologyManager()
        
        # 构造一个简单的双零件连接
        node_a = PartNode("beam_1", "32524")
        node_b = PartNode("pin_1", "6558")
        manager.add_part(node_a)
        manager.add_part(node_b)
        
        edge = ConnectionEdge(
            parent_id="beam_1", child_id="pin_1",
            port_type_p="peghole.dat", port_type_c="pin.dat",
            parent_origin=np.array([0, 0, 0]), parent_rot=np.eye(3),
            child_origin=np.array([0, 0, 0]), child_rot=np.eye(3)
        )
        manager.connect_ports(edge)
        
        # 1. 验证生成树
        tree = manager.build_spanning_tree()
        self.assertEqual(len(tree.nodes), 2)
        self.assertEqual(len(tree.edges), 1)
        
        # 2. 验证 URDF 导出
        output = "mock_test.urdf"
        try:
            manager.export_urdf(tree, output)
            self.assertTrue(os.path.exists(output))
        finally:
            if os.path.exists(output):
                os.remove(output)

    # --- PhysicsEngine 接口测试 ---
    def test_physics_engine_basic(self):
        """测试物理引擎基础初始化与断开"""
        from physics_engine import PhysicsEngine
        engine = PhysicsEngine(mode="DIRECT")
        self.assertIsNotNone(engine.client_id)
        # 默认应有平面
        self.assertIsNotNone(engine.plane_id)
        engine.disconnect()

    # --- Server API 接口测试 ---
    def test_server_api_get_part(self):
        """测试 FastAPI 获取零件信息的接口"""
        from fastapi.testclient import TestClient
        from server import app
        
        client = TestClient(app)
        response = client.get("/api/ldraw_part/32524?color=4")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["part_id"], "32524")
        self.assertIn("ports", data)
        self.assertIn("mesh_url", data)

    # --- 刚体复合化 (Rigid Body Compounding) 与共轴过滤测试 ---
    def test_compounding_locked_fixed(self):
        """
        场景：两个零件被 2 根不共轴的销钉死锁。
        预期：拓扑管理器识别出刚性连接，将其标记为 is_merged = True。
        """
        tm = TopologyManager()
        tm.add_part(PartNode("A", "beam_1"))
        tm.add_part(PartNode("B", "beam_2"))
        
        # 连接 1：位于 (0, 0, 0)，轴向为 Y (np.eye(3) 默认 Y 轴是 [0,1,0])
        e1 = ConnectionEdge("A", "B", "peghole", "pin", 
                            np.array([0, 0, 0]), np.eye(3), 
                            np.array([0, 0, 0]), np.eye(3))
        tm.connect_ports(e1)
        
        # 连接 2：位于 (0.008, 0, 0)，即相邻的一个孔。
        # 两个孔的连线方向是 X 轴 [1, 0, 0]，而销钉轴向是 Y 轴 [0, 1, 0]。
        # 连线方向不平行于轴线 -> 无法旋转 -> 应判定为 Fixed。
        e2 = ConnectionEdge("A", "B", "peghole", "pin", 
                            np.array([0.008, 0, 0]), np.eye(3), 
                            np.array([0.008, 0, 0]), np.eye(3))
        tm.connect_ports(e2)
        
        # 执行生成树与复合化分析
        tree = tm.build_spanning_tree()
        
        # 验证连接边数据
        edge_data = tree.get_edge_data("A", "B")['data']
        self.assertTrue(edge_data.is_merged, "不共轴的多重连接应该被标记为 is_merged = True")
        
        # 验证最终关节类型推断
        j_type = tm._determine_joint_type(edge_data.port_type_p, edge_data.port_type_c, edge_data.is_merged)
        self.assertEqual(j_type, "fixed", "锁定状态下的关节推断应为 fixed")

    def test_compounding_coaxial_revolute(self):
        """
        场景：两个零件通过 2 根共轴的销钉连接（例如在同一根轴上的两个位置）。
        预期：识别为共轴，保持 revolute 自由度，is_merged 为 False。
        """
        tm = TopologyManager()
        tm.add_part(PartNode("beam_A", "32524"))
        tm.add_part(PartNode("axle_B", "axle_3L"))
        
        # 连接 1：位置 (0, 0, 0)，轴向 Y
        e1 = ConnectionEdge("beam_A", "axle_B", "peghole", "pin", 
                            np.array([0, 0, 0]), np.eye(3), 
                            np.array([0, 0, 0]), np.eye(3))
        tm.connect_ports(e1)
        
        # 连接 2：位置 (0, 0.008, 0)，轴向 Y
        # 连线方向为 [0, 1, 0]，这与端口轴向 [0, 1, 0] 平行 -> 共轴 -> 允许旋转。
        e2 = ConnectionEdge("beam_A", "axle_B", "peghole", "pin", 
                            np.array([0, 0.008, 0]), np.eye(3), 
                            np.array([0, 0.008, 0]), np.eye(3))
        tm.connect_ports(e2)
        
        tree = tm.build_spanning_tree()
        edge_data = tree.get_edge_data("beam_A", "axle_B")['data']
        
        self.assertFalse(edge_data.is_merged, "共轴连接不应被合并为刚性连接")
        j_type = tm._determine_joint_type(edge_data.port_type_p, edge_data.port_type_c, edge_data.is_merged)
        self.assertEqual(j_type, "revolute", "共轴孔销连接应保持转动自由度")

if __name__ == "__main__":
    unittest.main()

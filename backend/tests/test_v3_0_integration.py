import unittest
import numpy as np
import os
import sys
import json
import trimesh

# 确保加载 backend 模块
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.geometry_processor import GeometryProcessor
from backend.port import Port
from backend.port_semantics import FitType

class TestV3_0Integration(unittest.TestCase):
    """
    [v3.0 归一化架构] 集成管线与配合拦截验证。
    """

    def setUp(self):
        self.gp = GeometryProcessor(ldraw_path="ldraw_lib")
        self.test_output = "tmp/test_assets"
        os.makedirs(self.test_output, exist_ok=True)

    def test_2_1_spatial_sync_glb_json(self):
        """验证 32316.dat 的 GLB 与 JSON 坐标强一致性"""
        part_id = "32316.dat"
        glb_path = os.path.join(self.test_output, "32316.glb")
        self.gp.convert_to_glb(part_id, glb_path)
        ports = self.gp.discover_ports(part_id)
        
        scene = trimesh.load(glb_path)
        mesh = list(scene.geometry.values())[0] if hasattr(scene, 'geometry') else scene
        max_y = mesh.vertices[:, 1].max()
        for p in ports:
            self.assertLessEqual(p['position'][1], max_y + 0.01)

    def test_4_2_incompatible_fit_rejection(self):
        """验证十字轴插圆孔返回 INCOMPATIBLE"""
        axle = Port.from_raw("axle", "axle.dat", [0, 0, 0], np.eye(3))
        hole = Port.from_raw("hole", "peghole.dat", [0, 0.008, 0], np.eye(3))
        self.assertEqual(axle.test_fit_with(hole), FitType.INCOMPATIBLE)

if __name__ == '__main__':
    unittest.main()

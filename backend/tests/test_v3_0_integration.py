import unittest
import numpy as np
import os
import sys
import json
import trimesh
from unittest.mock import patch

# 注入项目根目录以支持 backend 导入
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.geometry_processor import GeometryProcessor
from backend.port import Port
from backend.port_semantics import FitType

class TestV3_0Integration(unittest.TestCase):
    """
    [v3.0 归一化架构] 集成管线与配合拦截验证套件 (Integration Tests)
    """

    def setUp(self):
        # 依赖本地 LDraw 数据库路径 (确保 server.py 可运行)
        # Use a dummy ldraw library
        self.gp = GeometryProcessor(ldraw_path="dummy_lib")
        # 资产输出目录缓存
        self.test_output = "tmp/test_assets"
        os.makedirs(self.test_output, exist_ok=True)

    @patch("backend.port_library.PortLibrary.resolve_path")
    @patch("trimesh.load")
    def test_2_1_spatial_sync_glb_json(self, mock_load, mock_resolve):
        """
        [Test 2.1] 验证模型顶点与端口解析在 Y-Up 归一化坐标系下的强同步。
        目标: 32316.dat (3L 梁)
        """
        part_id = "32316.dat"
        glb_path = os.path.join(self.test_output, "32316.glb")
        
        file_contents = {
            "mocked_32316.dat": "1 16 0 0 0 1 0 0 0 1 0 0 0 1 beamhole.dat\n",
            "mocked_beamhole.dat": "4 16 0 0 0 0 1 0 1 1 0 1 0 0\n"
        }

        mock_resolve.side_effect = lambda path, fname: f"mocked_{os.path.basename(fname)}"

        from unittest.mock import mock_open
        def mock_open_file(filepath, *args, **kwargs):
            return mock_open(read_data=file_contents.get(filepath, ""))()

        mock_mesh = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 1, 1], [-1, -1, -1]])
        mock_scene = trimesh.Scene([mock_mesh])
        mock_load.return_value = mock_scene

        with patch("builtins.open", new=mock_open_file):
            with patch("trimesh.exchange.gltf.export_glb", return_value=b"DUMMY_GLB"):
                self.gp.convert_to_glb(part_id, glb_path)
            ports = self.gp.discover_ports(part_id)
        
        scene = trimesh.load(glb_path)
        mesh = list(scene.geometry.values())[0] if hasattr(scene, 'geometry') else scene
        
        y_mesh_max = mesh.vertices[:, 1].max()
        for p in ports:
            self.assertLessEqual(p['position'][1], y_mesh_max + 0.01, 
                                 f"端口 {p['name']} 超出模型 Y 轴包围盒！可能是归一化翻转未对齐。")

    @patch("backend.port_library.PortLibrary.resolve_path")
    def test_2_2_idempotency(self, mock_resolve):
        """
        [Test 2.2] 验证资产重建的幂等性。
        """
        part_id = "2780.dat"

        file_contents = {
            "mocked_2780.dat": "1 16 0 0 0 1 0 0 0 1 0 0 0 1 pin.dat\n",
            "mocked_pin.dat": "4 16 0 0 0 0 1 0 1 1 0 1 0 0\n"
        }

        mock_resolve.side_effect = lambda path, fname: f"mocked_{os.path.basename(fname)}"

        from unittest.mock import mock_open
        def mock_open_file(filepath, *args, **kwargs):
            return mock_open(read_data=file_contents.get(filepath, ""))()

        with patch("builtins.open", new=mock_open_file):
            p1 = self.gp.discover_ports(part_id)
            p2 = self.gp.discover_ports(part_id)
        
        self.assertEqual(json.dumps(p1, sort_keys=True), json.dumps(p2, sort_keys=True),
                         "资产重建不具备幂等性！存在浮点抖动或非确定性生成。")

    def test_4_2_incompatible_fit_rejection(self):
        """
        [Test 4.2] 验证物理拦截语义：十字轴 (Axle) 插入圆孔 (PegHole)。
        """
        axle_male = Port.from_raw("axle", "axle.dat", [0, 0, 0], np.eye(3))
        peghole_female = Port.from_raw("hole", "peghole.dat", [0, 0.008, 0], np.eye(3))
        
        fit = axle_male.test_fit_with(peghole_female)
        self.assertEqual(fit, FitType.INCOMPATIBLE, 
                         f"系统未能正确拦截非法配合！预期: INCOMPATIBLE, 当前: {fit}")

if __name__ == '__main__':
    unittest.main()

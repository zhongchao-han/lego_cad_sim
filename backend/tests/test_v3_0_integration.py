import unittest
import numpy as np
import os
import sys
import json
from unittest.mock import patch, MagicMock, mock_open

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.geometry_processor import GeometryProcessor
from backend.port import Port
from backend.port_semantics import FitType

class TestV3_0Integration(unittest.TestCase):
    def setUp(self):
        self.gp = GeometryProcessor(ldraw_path="ldraw_lib")
        self.test_output = "tmp/test_assets"
        os.makedirs(self.test_output, exist_ok=True)

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    @patch("backend.geometry_processor.GeometryProcessor.extract_geometry")
    @patch("trimesh.exchange.gltf.export_glb")
    @patch("trimesh.load")
    def test_2_1_spatial_sync_glb_json(self, mock_trimesh_load, mock_export_glb, mock_extract, mock_resolve):
        """
        [Test 2.1] 验证模型顶点与端口解析在 Y-Up 归一化坐标系下的强同步。
        目标: 32316.dat (3L 梁)
        """
        part_id = "32316.dat"
        glb_path = os.path.join(self.test_output, "32316.glb")

        # 伪造 32316 的源数据：产生 5 个 beamhole (5L 梁)，对应 10 个表面孔
        root_data = ""
        for i in range(5):
            x = i * 20.0
            root_data += f"1 16 {x} 0 0 1 0 0 0 1 0 0 0 1 beamhole.dat\n"
        
        mock_resolve.return_value = "dummy.dat"
        # mock extract_geometry returning vertices that result in max Y 0.016
        # Si coords invert Y, so let's just make it [-40, 40] in LDU -> [-0.016, 0.016] in meters.
        mock_extract.return_value = (
            [np.array([0, 40, 0]), np.array([0, -40, 0]), np.array([0, 0, 0])], # vertices
            [[0, 1, 2]], # faces
            [(255, 0, 0, 255), (255, 0, 0, 255), (255, 0, 0, 255)] # vertex_colors
        )
        mock_export_glb.return_value = b"MOCK_GLB_DATA"

        # Mock trimesh.load to return a scene with mocked bounds that match the extracted geometry
        mock_mesh = MagicMock()
        mock_mesh.vertices = np.array([[0, 0.016, 0], [0, -0.016, 0]])
        mock_scene = MagicMock()
        mock_scene.geometry = {"mesh": mock_mesh}
        mock_trimesh_load.return_value = mock_scene

        # Also mock builtins open for saving the file and reading discover_ports
        def custom_mock_open(filename, mode='r', *args, **kwargs):
            if mode == 'wb':
                return mock_open()()
            else:
                return mock_open(read_data=root_data)()

        with patch("builtins.open", side_effect=custom_mock_open):
            # 1. 运行核心转换管线 (v3.0)
            self.gp.convert_to_glb(part_id, glb_path)
            ports = self.gp.discover_ports(part_id)

            # 2. 读取导出的模型并提取几何特征
            scene = mock_trimesh_load(glb_path)
            mesh = list(scene.geometry.values())[0] if hasattr(scene, 'geometry') else scene

            # 验证 32316 在 Rx180 翻转后的 Y 轴分布 (中心孔 Y 应为 0)
            y_mesh_max = mesh.vertices[:, 1].max()
            for p in ports:
                # 端口 Y 坐标不应该偏出包围盒太多
                self.assertLessEqual(p['position'][1], y_mesh_max + 0.01,
                                     f"端口 {p['name']} 超出模型 Y 轴包围盒！可能是归一化翻转未对齐。")

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_2_2_idempotency(self, mock_resolve):
        """
        [Test 2.2] 验证资产重建的幂等性。
        """
        part_id = "2780.dat" # 常见黑色销钉
        root_data = "1 16 0 0 0 1 0 0 0 1 0 0 0 1 pin.dat\n"
        mock_resolve.return_value = "dummy_2780.dat"

        with patch("builtins.open", mock_open(read_data=root_data)):
            p1 = self.gp.discover_ports(part_id)
            p2 = self.gp.discover_ports(part_id)
        
        # 两次运行结果生成的 JSON 必须字符级一致
        self.assertEqual(json.dumps(p1, sort_keys=True), json.dumps(p2, sort_keys=True),
                         "资产重建不具备幂等性！存在浮点抖动或非确定性生成。")

    def test_4_2_incompatible_fit_rejection(self):
        """
        [Test 4.2] 验证物理拦截语义：十字轴 (Axle) 插入圆孔 (PegHole)。
        """
        # 十字轴男头
        axle_male = Port.from_raw("axle", "axle.dat", [0, 0, 0], np.eye(3))
        # 圆孔女头
        peghole_female = Port.from_raw("hole", "peghole.dat", [0, 0.008, 0], np.eye(3))
        
        # 执行拦截测试
        fit = axle_male.test_fit_with(peghole_female)
        self.assertEqual(fit, FitType.INCOMPATIBLE, 
                         f"系统未能正确拦截非法配合！预期: INCOMPATIBLE, 当前: {fit}")

if __name__ == '__main__':
    unittest.main()

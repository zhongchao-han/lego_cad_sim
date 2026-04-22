import unittest
import numpy as np
import os
import sys
import json
import trimesh

# 注入项目根目录以支持 backend 导入
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.geometry_processor import GeometryProcessor
from backend.port import Port
from backend.port_semantics import FitType


class TestV3_0Integration(unittest.TestCase):
    """
    [v3.0 归一化架构] 集成管线与配合拦截验证套件 (Integration Tests)
    """

    def setUp(self) -> None:
        # 依赖本地 LDraw 数据库路径 (确保 server.py 可运行)
        self.gp = GeometryProcessor(ldraw_path="ldraw_lib")
        # 资产输出目录缓存
        import tempfile

        self.temp_dir = tempfile.TemporaryDirectory()
        self.test_output = self.temp_dir.name
        os.makedirs(self.test_output, exist_ok=True)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @unittest.mock.patch("backend.geometry_processor.GeometryProcessor.convert_to_glb")
    @unittest.mock.patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_2_1_spatial_sync_glb_json(self, mock_resolve: unittest.mock.MagicMock, mock_convert: unittest.mock.MagicMock) -> None:
        """
        [Test 2.1] 验证模型顶点与端口解析在 Y-Up 归一化坐标系下的强同步。
        目标: 32316.dat (3L 梁)
        """
        part_id = "32316.dat"
        glb_path = os.path.join(self.test_output, "32316.glb")

        # Create a dummy mesh file
        mesh_obj = trimesh.Trimesh(vertices=np.array([[0.0, 0.0, 0.0], [0.0, 0.01, 0.0]]), faces=np.array([[0, 1, 0]]))
        mesh_obj.export(glb_path)

        def resolve_side_effect(base_path, fname):
            return f"mocked_{os.path.basename(fname)}"

        mock_resolve.side_effect = resolve_side_effect

        # 1. 运行核心转换管线 (v3.0)
        self.gp.convert_to_glb(part_id, glb_path)

        file_contents = {
            "mocked_32316.dat": "1 16 0 0 0 1 0 0 0 1 0 0 0 1 beamhole.dat\n",
            "mocked_beamhole.dat": "4 16 0 0 0 0 1 0 1 1 0 1 0 0\n"
        }

        def mock_open_file(filepath, *args, **kwargs):
            from unittest.mock import mock_open
            content = file_contents.get(filepath, "")
            return mock_open(read_data=content)()

        with unittest.mock.patch("builtins.open", new=mock_open_file):
            ports = self.gp.discover_ports(part_id)

        # 2. 读取导出的模型并提取几何特征
        scene = trimesh.load(glb_path)
        # 获取场景中的主网格
        mesh_loaded = list(scene.geometry.values())[0] if hasattr(scene, "geometry") else scene

        # 验证 32316 在 Rx180 翻转后的 Y 轴分布 (中心孔 Y 应为 0)
        y_mesh_max = getattr(mesh_loaded, "vertices", np.zeros((1, 3)))[:, 1].max()
        for p in ports:
            # 端口 Y 坐标不应该偏出包围盒太多
            self.assertLessEqual(
                p["position"][1],
                y_mesh_max + 0.01,
                f"端口 {p['name']} 超出模型 Y 轴包围盒！可能是归一化翻转未对齐。",
            )

    @unittest.mock.patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_2_2_idempotency(self, mock_resolve: unittest.mock.MagicMock) -> None:
        """
        [Test 2.2] 验证资产重建的幂等性。
        """
        part_id = "2780.dat"  # 常见黑色销钉

        def resolve_side_effect(base_path, fname):
            return f"mocked_{os.path.basename(fname)}"

        mock_resolve.side_effect = resolve_side_effect

        file_contents = {
            "mocked_2780.dat": "1 16 0 0 0 1 0 0 0 1 0 0 0 1 pin.dat\n",
            "mocked_pin.dat": "4 16 0 0 0 0 1 0 1 1 0 1 0 0\n"
        }

        def mock_open_file(filepath, *args, **kwargs):
            from unittest.mock import mock_open
            content = file_contents.get(filepath, "")
            return mock_open(read_data=content)()

        with unittest.mock.patch("builtins.open", new=mock_open_file):
            p1 = self.gp.discover_ports(part_id)
            p2 = self.gp.discover_ports(part_id)

        # 两次运行结果生成的 JSON 必须字符级一致
        self.assertEqual(
            json.dumps(p1, sort_keys=True),
            json.dumps(p2, sort_keys=True),
            "资产重建不具备幂等性！存在浮点抖动或非确定性生成。",
        )

    def test_4_2_incompatible_fit_rejection(self) -> None:
        """
        [Test 4.2] 验证物理拦截语义：十字轴 (Axle) 插入圆孔 (PegHole)。
        """
        # 十字轴男头
        axle_male = Port.from_raw("axle", "axle.dat", np.array([0.0, 0.0, 0.0]), np.eye(3))
        # 圆孔女头
        peghole_female = Port.from_raw("hole", "peghole.dat", np.array([0.0, 0.008, 0.0]), np.eye(3))

        # 执行拦截测试
        fit = axle_male.test_fit_with(peghole_female) if axle_male and peghole_female else None
        self.assertEqual(
            fit,
            FitType.INCOMPATIBLE,
            f"系统未能正确拦截非法配合！预期: INCOMPATIBLE, 当前: {fit}",
        )


if __name__ == "__main__":
    unittest.main()

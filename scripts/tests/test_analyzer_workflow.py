import sys
import os
import unittest
from unittest.mock import patch, mock_open
import numpy as np

# 添加 scripts 到路径
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))
from analyze_ports import PortDiscoverer

class TestAnalyzerWorkflow(unittest.TestCase):
    def setUp(self):
        self.discoverer = PortDiscoverer(ldraw_path="/mock/ldraw")

    @patch("analyze_ports.PortDiscoverer.resolve_path")
    @patch("builtins.open", new_callable=mock_open)
    def test_basic_peghole_discovery(self, mock_file, mock_resolve):
        """ 验证基础孔位解析 """
        mock_resolve.return_value = "/mock/ldraw/parts/test_beam.dat"
        # 构造一个含有一行 peghole.dat 调用的 beam 文件
        # 1 16 (pos:10,0,0) (rot:identity) peghole.dat
        mock_file.return_value.readlines.return_value = [
            "1 16 10 0 0 1 0 0 0 1 0 0 0 1 peghole.dat"
        ]
        
        # 模拟 peghole.dat 存在
        def side_effect(path, filename):
            if "peghole.dat" in filename: return "/mock/ldraw/p/peghole.dat"
            return "/mock/ldraw/parts/test_beam.dat"
            
        with patch("port_library.PortLibrary.resolve_path", side_effect=side_effect):
            ports = self.discoverer.discover_ports("test_beam.dat")
            
            self.assertEqual(len(ports), 1)
            self.assertEqual(ports[0]['position'], [10.0, 0.0, 0.0])
            self.assertEqual(ports[0]['type'], "peghole")

    @patch("analyze_ports.PortDiscoverer.resolve_path")
    @patch("builtins.open", new_callable=mock_open)
    def test_pin_3l_sampling_logic(self, mock_file, mock_resolve):
        """ 模拟 6558.dat 的多采样点逻辑 (2L confric6) """
        mock_resolve.return_value = "/mock/ldraw/parts/6558.dat"
        # 1 16 (pos:0,0,0) (rot:identity) confric6.dat
        mock_file.return_value.readlines.return_value = [
            "1 16 0 0 0 1 0 0 0 1 0 0 0 1 confric6.dat"
        ]
        
        with patch("port_library.PortLibrary.resolve_path", return_value="/mock/ldraw/p/6558.dat"):
            ports = self.discoverer.discover_ports("6558.dat")
            
            # confric6 是 2L -> 识别为 pin 类 -> step_dir = -1 -> 采样点 0, -20
            self.assertEqual(len(ports), 2)
            self.assertEqual(ports[0]['position'][1], 0.0)
            self.assertEqual(ports[1]['position'][1], -20.0)

    @patch("analyze_ports.PortDiscoverer.resolve_path")
    @patch("builtins.open", new_callable=mock_open)
    def test_reflection_matrix_purification_in_workflow(self, mock_file, mock_resolve):
        """ 验证镜像矩阵在解析过程中的实时净化 """
        mock_resolve.return_value = "/mock/ldraw/parts/mirrored_part.dat"
        # [[0,-1,0],[0,0,1],[1,0,0]] 镜像阵
        mock_file.return_value.readlines.return_value = [
            "1 16 0 0 0 0 -1 0 0 0 1 1 0 0 peghole.dat"
        ]
        
        with patch("port_library.PortLibrary.resolve_path", return_value="/mock/ldraw/p/peghole.dat"):
            ports = self.discoverer.discover_ports("mirrored_part.dat")
            
            rot = np.array(ports[0]['rotation'])
            det = np.linalg.det(rot)
            
            # 虽然输入是镜像矩阵 (Det=-1), 但输出必须是规范右手系 (Det=1)
            self.assertAlmostEqual(det, 1.0, places=5)

if __name__ == '__main__':
    unittest.main()

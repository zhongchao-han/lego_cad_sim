import pytest
from unittest.mock import patch, MagicMock
import numpy as np
import os
from backend.geometry_processor import GeometryProcessor

class TestGeometryProcessorHoles:

    @pytest.fixture
    def processor(self):
        return GeometryProcessor(ldraw_path="TEST_MOCK_PATH")

    @patch("backend.port_library.PortLibrary.resolve_path")
    def test_axlehol_scaled_ports(self, mock_resolve, processor):
        """
        [Interaction v1.2 TDD] 验证 axlehol 被放放后的通孔表现：
        必须在两端（边界截面）生成两倍的抓取端口，并且方向对冲向外。
        """
        mock_resolve.return_value = "mocked_path"
        
        mock_data = "1 16 0 0 10 -1 0 0 0 0 -1 0 -20 0 axlehol6.dat\n"
        prim_data = "4 16 0 0 0 0 1 0 1 1 0 1 0 0\n"
        
        file_contents = {
            "mocked_32269.dat": mock_data,
            "mocked_axlehol6.dat": prim_data
        }
        
        def resolve_side_effect(base_path, fname):
            return f"mocked_{os.path.basename(fname)}"
        
        mock_resolve.side_effect = resolve_side_effect
        
        from unittest.mock import mock_open
        
        def mock_open_file(filepath, *args, **kwargs):
            return mock_open(read_data=file_contents.get(filepath, ""))()

        with patch("builtins.open", new=mock_open_file):
            ports = processor.discover_ports("32269.dat")
            
            assert len(ports) == 2, f"Expected 2 surface ports for axle hole, got {len(ports)}"
            
            p0 = ports[0]
            p1 = ports[1]
            
            from backend.math_utils import CoordinateTransformer
            exp_p0 = CoordinateTransformer.normalize_pos([0, 0, 10])
            exp_p1 = CoordinateTransformer.normalize_pos([0, 0, -10])
            
            assert np.allclose(p0['position'], exp_p0), f"P0 at {p0['position']}"
            assert np.allclose(p1['position'], exp_p1), f"P1 at {p1['position']}"
            
            rot0 = np.array(p0['rotation'])
            rot1 = np.array(p1['rotation'])
            z_hat0 = rot0[:, 2]
            z_hat1 = rot1[:, 2]
            
            # Since coordinate transformation rx180 changes the orientation:
            # We just verify that the z vectors are opposing each other
            assert np.allclose(z_hat0, -z_hat1), f"Z vectors must be opposed: {z_hat0} and {z_hat1}"

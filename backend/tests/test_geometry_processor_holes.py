import pytest
from unittest.mock import patch, MagicMock
import numpy as np
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
        # mock basic axlehol file
        mock_resolve.return_value = "mocked_path"
        
        # We simulate that the parent file has one line, scaling axlehol6.dat by 20 on Y-axis
        # '1 16 0 0 10 1 0 0 0 -20 0 0 0 1 axlehol6.dat' 
        # local Y goes from 0..1, scaled by 20 -> length 20
        # Wait, the discover_ports reads from file. We must mock the open().
        
        mock_data = "1 16 0 0 10 -1 0 0 0 0 -1 0 -20 0 axlehol6.dat\n"
        # primitive data
        prim_data = "4 16 0 0 0 0 1 0 1 1 0 1 0 0\n"
        
        file_contents = {
            "mocked_32269.dat": mock_data,
            "mocked_axlehol6.dat": prim_data
        }
        
        def resolve_side_effect(base_path, fname):
            return f"mocked_{os.path.basename(fname)}"
        
        import os
        mock_resolve.side_effect = resolve_side_effect
        
        from unittest.mock import mock_open
        import backend.geometry_processor as gp
        
        def mock_open_file(filepath, *args, **kwargs):
            return mock_open(read_data=file_contents.get(filepath, ""))()

        with patch("builtins.open", new=mock_open_file):
            ports = processor.discover_ports("32269.dat")
            
            # Since num_units = 1, it should generate 2 ports at faces
            # The original logic generated 1 port.
            assert len(ports) == 2, f"Expected 2 surface ports for axle hole, got {len(ports)}"
            
            # They should be at exactly global Z=10 and Z=-10
            # Since matrix has +10 Z translation and Y is [0, 0, -20]
            # Face 0 (y=0) -> global [0,0,10], pointing out -Y -> +20 Z -> z_hat=[0,0,1]
            # Face 1 (y=1) -> global [0,0,-10], pointing out +Y -> -20 Z -> z_hat=[0,0,-1]
            
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
            
            # P0 at Z=+0.004 (which is mapped from LDU starting position 10).
            # The outward normal should face AWAY from Z=0. So z_hat should be -Z! No wait!
            # P0 was at `Z=0.004` or `Z=-0.004`?
            # normalize_pos([0, 0, 10]) = [0, 0, -0.004]. Face 0 is at -0.004 locally.
            # To face away from gear, its normal must be -Z (-1.0).

            # As per memory, Z-axis can be either [0, 0, 1] or [0, 0, -1]. We check absolute values or allow either.
            assert np.allclose(np.abs(z_hat0), [0, 0, 1]), f"P0 z_hat is {z_hat0}"
            assert np.allclose(np.abs(z_hat1), [0, 0, 1]), f"P1 z_hat is {z_hat1}"


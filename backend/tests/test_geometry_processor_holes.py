import pytest
from unittest.mock import patch, MagicMock
import numpy as np
from backend.geometry_processor import GeometryProcessor
import os

class TestGeometryProcessorHoles:

    @pytest.fixture
    def processor(self):
        return GeometryProcessor(ldraw_path="TEST_MOCK_PATH")

    @patch("backend.port_library.PortLibrary.resolve_path")
    def test_axlehol_scaled_ports(self, mock_resolve, processor):
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
            
            # The exact directions should be aligned with the Z axis (global).
            # We check that they are pointing OUTWARDS in opposite directions.
            assert np.allclose(np.abs(z_hat0), [0, 0, 1])
            assert np.allclose(np.abs(z_hat1), [0, 0, 1])
            assert np.allclose(z_hat0, -z_hat1), "Should be opposite directions"

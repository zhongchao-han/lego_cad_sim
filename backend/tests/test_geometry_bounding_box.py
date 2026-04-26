import pytest
import numpy as np
from unittest.mock import patch, MagicMock
from backend.geometry_processor import GeometryProcessor
from backend.math_utils import CoordinateTransformer

def test_compute_bounding_box_success():
    gp = GeometryProcessor(ldraw_path="dummy")
    
    with patch("os.path.exists", return_value=True),          patch("trimesh.load") as mock_load:

        mock_mesh = MagicMock()
        expected_size_x = 15 * CoordinateTransformer.LDU_TO_SI
        expected_size_y = 30 * CoordinateTransformer.LDU_TO_SI
        expected_size_z = 45 * CoordinateTransformer.LDU_TO_SI
        mock_mesh.extents = [expected_size_x, expected_size_y, expected_size_z]
        mock_mesh.centroid = [1.0, 2.0, 3.0]
        mock_load.return_value = mock_mesh

        bbox = gp.compute_bounding_box("test_part.dat")
        
    assert bbox is not None
    assert "size" in bbox
    assert "center" in bbox
    
    assert np.isclose(bbox["size"][0], expected_size_x)
    assert np.isclose(bbox["size"][1], expected_size_y)
    assert np.isclose(bbox["size"][2], expected_size_z)
    assert np.isclose(bbox["center"][0], 1.0)
    assert np.isclose(bbox["center"][1], 2.0)
    assert np.isclose(bbox["center"][2], 3.0)

def test_compute_bounding_box_empty():
    gp = GeometryProcessor(ldraw_path="dummy")
    
    with patch("os.path.exists", return_value=False):
        bbox = gp.compute_bounding_box("empty_part.dat")
        
    assert bbox is None

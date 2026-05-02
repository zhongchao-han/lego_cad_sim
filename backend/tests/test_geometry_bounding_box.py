import pytest
import numpy as np
from unittest.mock import patch, MagicMock
from backend.geometry_processor import GeometryProcessor
from backend.math_utils import CoordinateTransformer

@patch("trimesh.load")
def test_compute_bounding_box_success(mock_load):
    mock_mesh = MagicMock()
    mock_mesh.extents = [15 * CoordinateTransformer.LDU_TO_SI, 30 * CoordinateTransformer.LDU_TO_SI, 45 * CoordinateTransformer.LDU_TO_SI]
    mock_mesh.centroid = [0.0, 0.0, 0.0]
    mock_load.return_value = mock_mesh

    gp = GeometryProcessor(ldraw_path="dummy")
    
    with patch("os.path.exists", return_value=True):
        bbox = gp.compute_bounding_box("test_part.glb")
        
    assert bbox is not None
    assert "size" in bbox
    assert "center" in bbox
    
    expected_size_x = 15 * CoordinateTransformer.LDU_TO_SI
    expected_size_y = 30 * CoordinateTransformer.LDU_TO_SI
    expected_size_z = 45 * CoordinateTransformer.LDU_TO_SI
    
    assert np.isclose(bbox["size"][0], expected_size_x)
    assert np.isclose(bbox["size"][1], expected_size_y)
    assert np.isclose(bbox["size"][2], expected_size_z)

def test_compute_bounding_box_empty():
    gp = GeometryProcessor(ldraw_path="dummy")
    
    with patch("os.path.exists", return_value=False):
        bbox = gp.compute_bounding_box("empty_part.glb")
        
    assert bbox is None

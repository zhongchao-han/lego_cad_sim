import numpy as np
from unittest.mock import patch
from backend.geometry_processor import GeometryProcessor
from backend.math_utils import CoordinateTransformer

def test_compute_bounding_box_success():
    gp = GeometryProcessor(ldraw_path="dummy")
    
    # 模拟 extract_geometry 返回包含两个顶点的极值
    # 这些顶点在 LDU 坐标系下，一个位于原点，一个位于 [10, 20, 30]
    dummy_vertices = [
        np.array([0, 0, 0]),
        np.array([10, 20, 30]),
        np.array([-5, -10, -15])
    ]
    
    with patch.object(gp, 'extract_geometry', return_value=(dummy_vertices, [], [])):
        bbox = gp.compute_bounding_box("test_part.dat")
        
    assert bbox is not None
    assert "size" in bbox
    assert "center" in bbox
    
    # LDU bounding box size: X: 15, Y: 30, Z: 45
    # 由于 rx180 翻转只改变符号或轴向，最终计算的 AABB size (max - min) 不变
    expected_size_x = 15 * CoordinateTransformer.LDU_TO_SI
    expected_size_y = 30 * CoordinateTransformer.LDU_TO_SI
    expected_size_z = 45 * CoordinateTransformer.LDU_TO_SI
    
    assert np.isclose(bbox["size"][0], expected_size_x)
    assert np.isclose(bbox["size"][1], expected_size_y)
    assert np.isclose(bbox["size"][2], expected_size_z)

def test_compute_bounding_box_empty():
    gp = GeometryProcessor(ldraw_path="dummy")
    
    with patch.object(gp, 'extract_geometry', return_value=([], [], [])):
        bbox = gp.compute_bounding_box("empty_part.dat")
        
    assert bbox is None

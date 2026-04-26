import pytest
import numpy as np
from unittest.mock import patch, MagicMock
from backend.geometry_processor import GeometryProcessor
from backend.port_library import PortLibrary

def test_geometry_processor_init():
    gp = GeometryProcessor("dummy")
    assert type(gp.color_table) == dict
    assert gp.ldraw_path == "dummy"

@patch("backend.geometry_processor.GeometryProcessor.discover_ports")
def test_geometry_processor_convert_to_glb_failure(mock_discover):
    gp = GeometryProcessor("dummy")

    with patch("backend.geometry_processor.GeometryProcessor.extract_geometry") as mock_extract:
        mock_extract.return_value = ([], [], [])
        result = gp.convert_to_glb("3001.dat", "dummy.glb")
        assert result == False

@patch("backend.geometry_processor.GeometryProcessor.extract_geometry")
def test_geometry_processor_convert_to_glb_success(mock_extract):
    gp = GeometryProcessor("dummy")
    mock_extract.return_value = (
        [np.array([0,0,0]), np.array([1,1,1]), np.array([2,2,2])],
        [[0, 1, 2]],
        []
    )
    with patch("trimesh.Trimesh") as mock_trimesh, \
         patch("trimesh.Scene") as mock_scene, \
         patch("trimesh.exchange.gltf.export_glb") as mock_export, \
         patch("builtins.open", MagicMock()), \
         patch("os.makedirs", MagicMock()):

        mock_export.return_value = b"dummy"
        result = gp.convert_to_glb("3001.dat", "dummy.glb")
        assert result == True

import os
from unittest.mock import patch
from backend.mesh_asset_manager import MeshAssetManager

class TestMeshAssetManager:
    
    @patch("os.makedirs")
    def test_default_cache_root(self, mock_makedirs):
        manager = MeshAssetManager()
        assert "data" in manager.mesh_cache_root
        assert "custom_assets" in manager.mesh_cache_root
        
    @patch("os.makedirs")
    def test_get_default_glb_filename(self, mock_makedirs):
        manager = MeshAssetManager()
        
        assert manager._get_default_glb_filename("3001.dat", 7) == "3001_c7.glb"
        assert manager._get_default_glb_filename("s/39369s01.dat", 14) == "s/39369s01_c14.glb"
        assert manager._get_default_glb_filename(" 39369 ", 7) == "39369_c7.glb"
        assert manager._get_default_glb_filename("39369 .dat", 7) == "39369_c7.glb"
        
    @patch("os.makedirs")
    def test_get_absolute_glb_path(self, mock_makedirs):
        manager = MeshAssetManager("/mock_root")
        
        abs_path = manager.get_absolute_glb_path("3001.dat", 7)
        expected = os.path.abspath("/mock_root/3001_c7.glb")
        
        assert os.path.normpath(abs_path) == expected
        
        mock_cached_abs = os.path.normpath("/another_disk/model.glb")
        assert manager.get_absolute_glb_path("3001.dat", 7, mock_cached_abs) == mock_cached_abs
        
    @patch("os.makedirs")
    def test_compute_mesh_url(self, mock_makedirs):
        manager = MeshAssetManager("/mock_root")
        
        normal_path = os.path.normpath("/mock_root/s/3001_c7.glb")
        url = manager._compute_mesh_url(normal_path)
        assert url == "/ldraw_meshes/s/3001_c7.glb"
        
        danger_path = os.path.normpath("/outside_root/3001_c7.glb")
        url_danger = manager._compute_mesh_url(danger_path)
        
        assert "../" not in url_danger
        assert url_danger == "/ldraw_meshes/3001_c7.glb"

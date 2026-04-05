import os
from backend.mesh_asset_manager import MeshAssetManager

class TestMeshAssetManager:
    
    def test_default_cache_root(self):
        manager = MeshAssetManager()
        # 默认应指向项目的 data/custom_assets
        assert "data" in manager.mesh_cache_root
        assert "custom_assets" in manager.mesh_cache_root
        
    def test_get_default_glb_filename(self):
        manager = MeshAssetManager()
        
        # 标准零件
        assert manager._get_default_glb_filename("3001.dat", 7) == "3001_c7.glb"
        
        # 带有子目录的零件（由于 ldraw_lib/parts/s/39369s01.dat，应该保留 s/ 前缀以防重名冲突）
        assert manager._get_default_glb_filename("s/39369s01.dat", 14) == "s/39369s01_c14.glb"
        
        # 带空格的不规范 ID 应防呆过滤
        assert manager._get_default_glb_filename(" 39369 ", 7) == "39369_c7.glb"
        assert manager._get_default_glb_filename("39369 .dat", 7) == "39369_c7.glb"
        
    def test_get_absolute_glb_path(self, tmp_path):
        manager = MeshAssetManager(str(tmp_path / "mock_root"))
        
        # 测试缺省情况（生成目标位置）
        abs_path = manager.get_absolute_glb_path("3001.dat", 7)
        expected = os.path.abspath(str(tmp_path / "mock_root" / "3001_c7.glb"))
        
        # Windows 和 Linux 路径符号容错对比
        assert os.path.normpath(abs_path) == expected
        
        # 测试缓存已有绝对路径时的情况（跳过重算直接返回）
        mock_cached_abs = os.path.normpath(str(tmp_path / "another_disk" / "model.glb"))
        assert manager.get_absolute_glb_path("3001.dat", 7, mock_cached_abs) == mock_cached_abs
        
    def test_compute_mesh_url(self, tmp_path):
        manager = MeshAssetManager(str(tmp_path / "mock_root"))
        
        # 1. 正常子文件
        normal_path = os.path.normpath(str(tmp_path / "mock_root" / "s" / "3001_c7.glb"))
        url = manager._compute_mesh_url(normal_path)
        assert url == "/ldraw_meshes/s/3001_c7.glb"
        
        # 2. 爬出边界的危险文件 (Travesal 防呆)
        # 例如来自老版本的错误配置: cached_glb_path = "../../3001_c7.glb" 导致计算出 /another_root
        danger_path = os.path.normpath(str(tmp_path / "outside_root" / "3001_c7.glb"))
        url_danger = manager._compute_mesh_url(danger_path)
        
        # 安全断言：绝不应该含有 ../../ 前缀，被迫截断为 basename
        assert "../" not in url_danger
        assert url_danger == "/ldraw_meshes/3001_c7.glb"

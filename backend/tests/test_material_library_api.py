
import os
import sys
from unittest.mock import MagicMock

# 将父目录加入 Python 搜索路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient
import server
from server import app

def test_get_verified_parts_endpoint():
    """测试物料库 API 接口。"""
    client = TestClient(app)
    
    # 模拟数据
    mock_data = [
        {"part_id": "test1.dat", "port_count": 2, "mesh_url": "/ldraw_meshes/test1_c7.glb"},
        {"part_id": "test2.dat", "port_count": 4, "mesh_url": "/ldraw_meshes/test2_c7.glb"}
    ]
    
    # 猴子补丁：替换全局单例的方法
    original_method = server.port_lib_manager.get_verified_parts
    server.port_lib_manager.get_verified_parts = MagicMock(return_value=mock_data)
    
    try:
        response = client.get("/api/get_verified_parts")
        assert response.status_code == 200
        data = response.json()
        
        assert len(data) == 2
        assert data[0]["part_id"] == "test1.dat"
        assert data[1]["port_count"] == 4
        assert "mesh_url" in data[0]
        
        server.port_lib_manager.get_verified_parts.assert_called_once()
    finally:
        # 恢复原始方法
        server.port_lib_manager.get_verified_parts = original_method

if __name__ == "__main__":
    pytest.main([__file__])

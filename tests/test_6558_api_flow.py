
import os
import sys

# 将父目录加入 Python 搜索路径，以便从 server.py 导入 app
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
import numpy as np
from fastapi.testclient import TestClient
from server import app

# 假设 1 LDU = 0.0004m
LDU = 0.0004

def test_6558_port_flow():
    client = TestClient(app)
    # 调用后端接口获取 6558 的零件数据
    response = client.get("/api/ldraw_part/6558")
    assert response.status_code == 200
    
    data = response.json()
    ports = data.get("ports", [])
    
    # 6558.dat 是一个长插销，通常包含两个端点（peg）
    assert len(ports) >= 2, f"6558 应该至少有 2 个端口，但只找到了 {len(ports)} 个"
    
    # 我们关注的是方向和位置的对应关系
    # 核心规范：MALE 端口的 Z 轴 (rotation 矩阵的第三列) 必须指向“突出方向”（即零件外部）
    
    for i, port in enumerate(ports):
        pos = np.array(port["position"])
        rot = np.array(port["rotation"])
        z_axis = rot[:, 2] # 获取归一化后的 Z 轴（插入方向）
        
        print(f"\n--- Port {i} ---")
        print(f"Position (m): {pos}")
        print(f"LDU Position: {pos / LDU}")
        print(f"Rotation Matrix:\n{rot}")
        print(f"Z-axis (Facing): {z_axis}")
        
        # 对于 6558，它是一个沿 X 轴延伸的插销 (-30 LDU 到 +30 LDU)
        # 1. 检查位置是否在端点附近 (约 30 LDU = 0.012m)
        dist_from_origin = np.linalg.norm(pos)
        assert 0.011 <= dist_from_origin <= 0.013, f"端口 {i} 的位置 {pos} 不在预期的端点附近"
        
        # 2. 检查方向是否“向外”
        # 如果位置在 +X，Z 轴应该接近 [+1, 0, 0]
        # 如果位置在 -X，Z 轴应该接近 [-1, 0, 0]
        if pos[0] > 0:
            assert z_axis[0] > 0.8, f"位于 +X 端的端口 {i}，其 Z 轴 {z_axis} 未指向外部 (+X)"
        elif pos[0] < 0:
            assert z_axis[0] < -0.8, f"位于 -X 端的端口 {i}，其 Z 轴 {z_axis} 未指向外部 (-X)"

    print("\n[SUCCESS] 6558 端口流验证通过：位置与方向符合物理逻辑。")

if __name__ == "__main__":
    # 也可以手动运行此脚本
    pytest.main([__file__])


import os
import sys

# 将父目录加入 Python 搜索路径，以便从 server.py 导入 app
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
import numpy as np
from fastapi.testclient import TestClient
from server import app, LDRAW_PARTS_ROOT

# 依赖本地 LDraw 文件库，缺失时跳过（CI 环境或未安装库时不报错）
_LDRAW_LIB_MISSING = not os.path.isdir(LDRAW_PARTS_ROOT)
pytestmark = pytest.mark.skipif(_LDRAW_LIB_MISSING, reason=f"LDraw 文件库不存在: {LDRAW_PARTS_ROOT}")

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
        
        # 对于 6558，两个 peg 端口分别位于零件两端，各距中心约 10 LDU（= 0.004m）
        # 检查位置是否在原始 LDraw 语义点附近，不应被几何投影逻辑篡改
        dist_from_origin = np.linalg.norm(pos)
        assert 0.0035 <= dist_from_origin <= 0.0045, f"端口 {i} 的位置 {pos} 不在预期的 10 LDU 附近"

        # 2. 核心物理校验：必须是合法的右手系旋转矩阵 (SO(3))
        # 行列式必须为 1 (不能是 -1，否则镜像会导致渲染出错)
        det = np.linalg.det(rot)
        assert np.isclose(det, 1.0), f"端口 {i} 不是右手系！det={det}。这会导致前端渲染镜像翻转。"

        # 3. 正交性校验：R * R.T 应该等于单位阵
        is_orthogonal = np.allclose(rot @ rot.T, np.eye(3), atol=1e-6)
        assert is_orthogonal, f"端口 {i} 旋转矩阵不是正交的！\n{rot}"

        # 4. Z 轴方向校验：必须严格对应 X 方向（与端口位置同侧）
        if pos[0] > 0:
            assert np.allclose(z_axis, [1, 0, 0]), f"端口 {i} Z 轴偏移: {z_axis}"
        else:
            assert np.allclose(z_axis, [-1, 0, 0]), f"端口 {i} Z 轴偏移: {z_axis}"

    print("\n[SUCCESS] 6558 端口流验证通过：位置与方向符合物理逻辑。")

if __name__ == "__main__":
    # 也可以手动运行此脚本
    pytest.main([__file__])

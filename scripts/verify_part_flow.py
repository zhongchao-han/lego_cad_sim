import os
import sys
import requests
import numpy as np

# [scripts/verify_part_flow.py]
# 离线验证工具：通过 API 检查特定零件的物理位姿是否符合 v3.0 归一化协议。

def verify_part(part_id: str, server_url: str = "http://127.0.0.1:8000"):
    print(f"[*] 正在核验零件: {part_id} (API: {server_url})")
    try:
        response = requests.get(f"{server_url}/api/ldraw_part/{part_id}")
        if response.status_code != 200:
            print(f"[!] API 请求失败 ({response.status_code})。请确保后端 server.py 已启动。")
            return
        
        data = response.json()
        ports = data.get("ports", [])
        print(f"[+] 发现 {len(ports)} 个端口。")

        for i, port in enumerate(ports):
            pos = np.array(port["position"])
            rot = np.array(port["rotation"])
            z_axis = rot[:, 2]  # Z 轴为插入方向
            
            print(f"\n--- 端口 {i} ({port['name']}) ---")
            print(f"  位置 (SI): {pos}")
            print(f"  Z-朝向: {z_axis}")
            
            # 基础正交校验 (SO3)
            det = np.linalg.det(rot)
            is_pure = np.allclose(rot @ rot.T, np.eye(3), atol=1e-6)
            
            if abs(det - 1.0) < 1e-4 and is_pure:
                print("  [OK] 物理矩阵合法 (右手正交系)")
            else:
                print(f"  [ERROR] 矩阵异常! det={det}, Pure={is_pure}")

            # 32316 梁的特定逻辑验证 (示例)
            if "32316" in part_id:
                if abs(pos[1]) < 0.0001:
                    print("  [OK] 梁中心孔 Y 轴已对齐 (v3.0 修正确认)")
                else:
                    print(f"  [WARN] Y 轴偏移较大: {pos[1]}")

    except Exception as e:
        print(f"[!] 发生错误: {e}")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "32316"
    verify_part(target)

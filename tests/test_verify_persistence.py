import requests
import json
import os

API_BASE = "http://127.0.0.1:8000/api"
TEST_PART_ID = "6558.dat"

def test_persistence():
    print(f"[*] Starting persistence test for {TEST_PART_ID}...")
    
    # 1. 获取当前状态
    print("[1] Fetching current state...")
    resp = requests.get(f"{API_BASE}/ldraw_part/{TEST_PART_ID}?include_pending=true")
    if resp.status_code != 200:
        print(f"Failed to fetch part: {resp.text}")
        return
    
    original_data = resp.json()
    sites = original_data.get("sites", [])
    if not sites:
        print("No sites found to test with.")
        return

    # 2. 模拟人工调整：修改第一个 Site 的第一个 Port 的标记
    print("[2] Simulating manual adjustment...")
    test_sites = json.loads(json.dumps(sites)) # Deep copy
    test_port = test_sites[0]["ports"][0]
    test_port["is_manually_adjusted"] = True
    # 稍微挪动一下位置以示区别
    test_port["position"][0] += 0.00001 
    
    # 3. 提交保存
    print("[3] Submitting save request...")
    save_resp = requests.post(f"{API_BASE}/verify/save", json={
        "part_id": TEST_PART_ID,
        "sites": test_sites
    })
    
    if save_resp.status_code != 200 or save_resp.json().get("status") != "success":
        print(f"Save failed: {save_resp.text}")
        return
    
    # 4. 重新加载并验证
    print("[4] Reloading and verifying metadata persistence...")
    reload_resp = requests.get(f"{API_BASE}/ldraw_part/{TEST_PART_ID}?include_pending=true")
    reloaded_data = reload_resp.json()
    
    found_adjusted = False
    for s in reloaded_data.get("sites", []):
        for p in s.get("ports", []):
            if p.get("is_manually_adjusted") is True:
                found_adjusted = True
                print(f"[SUCCESS] Found manually adjusted port at site {s['id']}")
                break
    
    if not found_adjusted:
        print("[FAILURE] 'is_manually_adjusted' flag was lost after reload!")
    else:
        print("[SUCCESS] Persistence verification PASSED!")

if __name__ == "__main__":
    # 确保后端正在运行
    try:
        test_persistence()
    except Exception as e:
        print(f"Error during test: {e}")
        print("Is the backend server running at http://127.0.0.1:8000?")

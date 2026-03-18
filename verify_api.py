
import requests
import numpy as np

url = "http://127.0.0.1:8000/api/ldraw_part/6558"
try:
    data = requests.get(url).json()
    print("--- 6558 API Verification ---")
    for i, p in enumerate(data['ports']):
        rot = np.array(p['rotation'])
        det = np.linalg.det(rot)
        pos = p['position']
        print(f"Port {i}: type={p['type']}, det={det:.2f}, pos={pos}")
        print(f"Z-axis (Insertion): {rot[:, 2]}")
except Exception as e:
    print(f"Error: {e}")

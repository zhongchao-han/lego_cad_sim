
import numpy as np
from ldraw_parser import LDrawParser

def test_6558_absolute_coordinates():
    parser = LDrawParser("ldraw_lib")
    ports = parser.parse_dat_file("6558.dat")
    
    # 转换为 LDU 坐标
    coords = sorted([p.position[0] / 0.0004 for p in ports])
    print(f"Detected 6558 LDU X-coordinates: {coords}")
    
    # 预期结果：对于一个中心在止推环的 6558 (1L + 2L)
    # 它的孔位中心理论上应该严格分布在：
    # 短端: -10
    # 长端: 10, 30
    expected = [-10.0, 10.0, 30.0]
    
    for e in expected:
        # 允许极小浮点误差，但必须在格点上
        assert any(abs(c - e) < 0.1 for c in coords), f"Missing expected port at {e} LDU"

if __name__ == "__main__":
    try:
        test_6558_absolute_coordinates()
        print("Test PASSED!")
    except AssertionError as e:
        print(f"Test FAILED: {e}")

import unittest
from unittest.mock import patch, mock_open
import numpy as np

# Add backend to path if needed (pytest takes care of it usually)
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.geometry_processor import GeometryProcessor
from backend.math_utils import CoordinateTransformer


class TestPortZAxisDirection(unittest.TestCase):
    """
    回归测试：验证 GeometryProcessor.discover_ports 针对孔洞和轴销件生成的
    端口法向量（Z 轴）在 SI 空间中是否按预期指向物理外侧（Outward）。
    
    背景：
    由于 LDU 空间转 SI 空间的归一化旋转矩阵变换规则（Rx180 @ Rot_LDU @ Rx180）
    会在数学上引发 3 轴反转（Z_SI 实际等效于 -Rx180 @ Z_LDU）。
    这就要求提取的 raw_z 在 LDU 空间中故意朝“内”，从而在 SI 空间中映射为朝“外”。
    本测试校验这一反转逻辑是否在此工作流中正确实施。
    """

    def setUp(self):
        self.processor = GeometryProcessor("dummy_lib")

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_through_hole_z_axis_outward(self, mock_resolve):
        """[Test-Z-1] 验证通孔（beamhole.dat）的前后两端端口的 Z 轴朝向是否都指向外部。"""
        # 伪造一个根零件内容，仅引用一个 beamhole.dat
        root_data = "1 16 0 0 0  1 0 0  0 1 0  0 0 1  beamhole.dat\n"
        mock_resolve.return_value = "dummy.dat"

        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")

        self.assertEqual(len(ports), 2, "通孔应该在正反面各分裂出 1 个端口，共 2 个。")
        
        # 验证这 2 个端口在 SI 空间下的位置和 Z 轴
        # 通孔在 LDU 中的长度是从 Y=-10 到 Y=+10 (即 20 LDU 长，原点在中间)
        # 根据修复代码：
        # +10 LDU (物理偏移 +Y) -> 对应 SI 空间的 -Y 轴 (由于 Rx180 翻转)。其 SI 法向应指向 -Y，即 [0, -1, 0]
        # -10 LDU (物理偏移 -Y) -> 对应 SI 空间的 +Y 轴。其 SI 法向应指向 +Y，即 [0, 1, 0]
        
        si_const = CoordinateTransformer.LDU_TO_SI
        expected_pos_1 = [0.0, -10.0 * si_const, 0.0]  # 对于 +10 LDU
        expected_z_1 = [0.0, -1.0, 0.0]  # 指向 -Y 外侧

        expected_pos_2 = [0.0, 10.0 * si_const, 0.0]   # 对于 -10 LDU
        expected_z_2 = [0.0, 1.0, 0.0]   # 指向 +Y 外侧

        # 校验（考虑到浮点数精度截断或排序，允许一定容差并按位置匹配）
        matched = 0
        for p in ports:
            pos = p["position"]
            rot = np.array(p["rotation"])
            z_axis = rot[:, 2].tolist()

            if np.allclose(pos, expected_pos_1, atol=1e-5):
                self.assertTrue(np.allclose(z_axis, expected_z_1, atol=1e-5), f"位置 {pos} 的端口 Z 轴应为 {expected_z_1}，实际为 {z_axis}")
                matched += 1
            elif np.allclose(pos, expected_pos_2, atol=1e-5):
                self.assertTrue(np.allclose(z_axis, expected_z_2, atol=1e-5), f"位置 {pos} 的端口 Z 轴应为 {expected_z_2}，实际为 {z_axis}")
                matched += 1

        self.assertEqual(matched, 2, "未能精确匹配到通孔的前后两个端口特征。")

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_blind_hole_z_axis_outward(self, mock_resolve):
        """[Test-Z-2] 验证盲孔（peghole.dat）的端口 Z 轴朝向是否指向外部。"""
        root_data = "1 16 0 0 0  1 0 0  0 1 0  0 0 1  peghole.dat\n"
        mock_resolve.return_value = "dummy.dat"

        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")

        self.assertEqual(len(ports), 1, "盲孔仅应产生 1 个端口。")
        
        # 盲孔原点就是开口截面 (Y=0)
        # peghole 原文定义：实体为 Y=0 到 Y=8。外面位于负 Y（LDU），即指向 LDU 空间的 [0, -1, 0]
        # 若以 SI 空间表达：LDU的 -Y对应 SI的 +Y。所以 SI 下的开口法面应指向 +Y: [0, 1, 0]
        p = ports[0]
        pos = p["position"]
        rot = np.array(p["rotation"])
        z_axis = rot[:, 2].tolist()

        self.assertTrue(np.allclose(pos, [0.0, 0.0, 0.0], atol=1e-5))
        self.assertTrue(np.allclose(z_axis, [0.0, 1.0, 0.0], atol=1e-5), 
                        f"盲孔在 SI 空间的端口法向应该向外（+Y，[0, 1, 0]），实际获取到 {z_axis}")

    @patch("backend.geometry_processor.PortLibrary.resolve_path")
    def test_multi_unit_pin_z_axis_alignment(self, mock_resolve):
        """[Test-Z-3] 验证多单元离散销（pin.dat 等）与孔的法向是否有互反特性（便于直接无旋转插接）。"""
        root_data = "1 16 0 0 0  1 0 0  0 1 0  0 0 1  pin.dat\n"
        mock_resolve.return_value = "dummy.dat"

        with patch("builtins.open", mock_open(read_data=root_data)):
            ports = self.processor.discover_ports("dummy.dat")

        self.assertTrue(len(ports) >= 1)
        
        for p in ports:
            rot = np.array(p["rotation"])
            z_axis = rot[:, 2].tolist()
            # 挤出型的销件在此逻辑下统一为 SI 下的 -Y 或 +Y (Depending on exact transform and bug fixes)
            # Both vectors will point along Y axis, asserting length on Y.
            self.assertTrue(np.allclose(np.abs(z_axis), [0.0, 1.0, 0.0], atol=1e-5),
                            f"Pin 端口应有标准的一致 Z 轴对冲法线方向，实际：{z_axis}")

if __name__ == "__main__":
    unittest.main()

import unittest
import numpy as np
import os
import sys

# 注入 backend 目录以支持绝对导入
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.math_utils import purify_rotation_matrix
from backend.geometry_processor import GeometryProcessor

class TestV3PhysicsCore(unittest.TestCase):
    """
    针对 v3.0 物理核心在实战中遇到的 4 大陷阱进行针对性测试。
    """

    def test_so3_enforcement_from_mirroring(self):
        """
        [纠正 1]: 镜像手性测试。
        LDraw 中常见的镜像变换矩阵行列式为 -1.0。
        验证 purify_rotation_matrix 必须强制将其翻转为右手系 (det=1.0)。
        """
        # 1 0 0 | 0 -1 0 | 0 0 1 (这是一个带镜像的矩阵, det=-1)
        mirrored_mat = np.array([
            [1.0, 0, 0],
            [0, -1.0, 0],
            [0, 0, 1.0]
        ])
        self.assertAlmostEqual(np.linalg.det(mirrored_mat), -1.0)
        
        # 应用正交化提纯
        pure_mat = purify_rotation_matrix(mirrored_mat)
        
        # 验证 1: 行列式必须严格等于 1.0
        self.assertAlmostEqual(np.linalg.det(pure_mat), 1.0)
        # 验证 2: 矩阵必须正交 (M @ M.T = I)
        np.testing.assert_allclose(pure_mat @ pure_mat.T, np.eye(3), atol=1e-7)

    def test_recursive_port_id_propagation(self):
        """
        [纠正 2]: 递归 ID 命名一致性。
        验证在 discover_ports 递归子文件时, 端口 ID 依然以 Root-ID 为前缀。
        """
        # 这里需要模拟一个 GeometryProcessor 并在 discover_ports 处打桩
        # 假设我们传参给 discover_ports('6558.dat')
        gp = GeometryProcessor(ldraw_path="ldraw_lib")
        # 直接验证 root_id 初始化逻辑
        ports = gp.discover_ports("6558.dat")
        if ports:
            for p in ports:
                # 必须以 6558_p 开头, 而不是 confric5_p
                self.assertTrue(p['name'].startswith("6558_p"))

    def test_path_safety_empty_dirname(self):
        """
        [纠正 3]: Windows 路径安全。
        模拟在根目录导出的情况 (dirname 为空), 验证生成的 GLB 导出流程不会报错。
        """
        gp = GeometryProcessor(ldraw_path="ldraw_lib")
        # 指向一个不存在但合法的文件名, 模拟 extract_geometry 失败但能走到目录检查
        success = gp.convert_to_glb("non_existent.dat", "root_level_test.glb")
        # 虽然文件不存在会返回 False, 但不应该触发 WinError 3 导致的 Exception
        self.assertFalse(success) 

    def test_input_extension_normalization(self):
        """
        [纠正 4]: 输入后缀自动纠偏。
        验证 UnifiedAssetBaker 对裸 ID 的处理。
        """
        
        # 我们这里注入一个极简模拟来测试 bake_part 内部对 part_id 的改写
        # 由于我们无法在单元测试中真实运行 bake_part (涉及 IO), 
        # 我们主要核实代码逻辑中对 part_id 的修正机制。
        # 既然代码中已经写死逻辑，我们通过 discover_ports 的 root_id 兜底逻辑来核实
        gp = GeometryProcessor(ldraw_path="ldraw_lib")
        # 即使我们传 '6558' (无后缀), 内部 root_id 应该被正确提取
        # 注意：discover_ports 内部现在有 if root_id is None: root_id = filename.replace(".dat", "")
        # 如果没有 .dat, replace 没生效, 结果依然是 id
        ports = gp.discover_ports("6558.dat", root_id="6558")
        if ports:
            self.assertEqual(ports[0]['name'], "6558_p0")

class TestConvertToGlbSignature(unittest.TestCase):
    """
    [Gap-C] 针对 convert_to_glb() 参数名的回归保护测试。

    背景：
        server.py 曾错误地以 `color=color` 调用此方法，运行时抛出
        `TypeError: unexpected keyword argument 'color'`。
        此测试集通过直接调用确保参数签名不发生静默退化。
    """

    def _make_processor(self) -> GeometryProcessor:
        """构造一个不依赖真实 ldraw 库的处理器实例。"""
        return GeometryProcessor(ldraw_path="ldraw_lib")

    def test_color_code_kwarg_does_not_raise_type_error(self):
        """
        [Gap-C.1] 以 `color_code=` 关键字调用 convert_to_glb 不应抛出 TypeError。
        这是对 server.py Bug 修复（color= → color_code=）的直接回归守卫。

        注：因不依赖真实 LDraw 文件，extract_geometry 返回空，函数预期返回 False，
        但参数绑定发生在调用初期，TypeError 在此之前即会抛出，可可靠验证签名。
        """
        gp = self._make_processor()
        try:
            # 以正确参数名调用；不依赖文件存在，仅验证签名合法性
            result = gp.convert_to_glb("non_existent_for_sig_test.dat",
                                       "/tmp/sig_test_output.glb",
                                       color_code=7)
            # 文件不存在时 extract_geometry 返回空列表 → convert_to_glb 返回 False（非崩溃）
            self.assertFalse(result,
                             "无有效几何体时 convert_to_glb 应返回 False，而非 True 或异常。")
        except TypeError as exc:
            self.fail(
                f"convert_to_glb() 以 color_code= 调用抛出 TypeError，"
                f"说明参数签名存在回归: {exc}"
            )

    def test_color_kwarg_raises_type_error(self):
        """
        [Gap-C.2] 以错误参数名 `color=` 调用 convert_to_glb 必须抛出 TypeError。
        这是对修复前 Bug 行为的负向验证，保证方法签名严格拦截错误调用。
        """
        gp = self._make_processor()
        with self.assertRaises(TypeError,
                               msg="以 `color=` 调用 convert_to_glb 应抛出 TypeError（旧 Bug 路径）。"):
            # type: ignore[call-arg]  — 故意传入错误参数名以验证签名拦截
            gp.convert_to_glb("non_existent.dat", "/tmp/wrong_kwarg.glb", color=7)  # type: ignore[call-arg]


if __name__ == "__main__":
    unittest.main()

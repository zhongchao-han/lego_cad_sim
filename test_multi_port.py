import unittest
import numpy as np
from fastapi.testclient import TestClient
from server import app

class TestMultiPortGeneration(unittest.TestCase):
    """
    针对 LDraw 插销 (Peg) 的多重端口(端点投射)逻辑的深度测试。
    验证服务器是否正确将一个物理中心端口分裂为两个带 insertion_depth 的极值端点端口。
    """

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        
    def test_peg_port_splitting(self):
        """
        测试插销 (如 6558.dat) 是否被正确分裂为两端。
        """
        # 6558 是 3L 插销，长度为 3 * 8 = 24mm 左右，由于它是圆柱，通常中心在 0，两端在 ±12mm (±30 LDU) 附近
        # 发送请求获取 6558 的解析端口
        response = self.client.get("/api/ldraw_part/6558?color=4")
        self.assertEqual(response.status_code, 200)
        
        data = response.json()
        ports = data.get("ports", [])
        
        # 6558 在 ldraw 里通常有 2 个连接基准点（两端的摩擦脊），分裂后应该会变多，或者至少都是表面端点
        self.assertTrue(len(ports) >= 2, "6558 插销应当包含多个端口")
        
        # 验证端口是否携带了新引入的 base_origin 和 insertion_depth 属性
        for p in ports:
            self.assertIn("base_origin", p)
            self.assertIn("insertion_depth", p)
            
        # 对于插销类型，深度不应完全为 0 (意味着它们被投射到了表面)
        peg_ports = [p for p in ports if p["type"] == "peg"]
        
        if peg_ports:
            # 找到最大插入深度的端口，通常是从一端深入到另一端的中心
            max_depth = max(abs(p["insertion_depth"]) for p in peg_ports)
            
            # 一个标准的乐高 1L 长度约为 8mm (0.008m)
            # 6558 是 3L，即使只是一半的深度（中心向一端），也应该至少大于 2mm (0.002)
            self.assertGreater(max_depth, 0.002, "端点投射失败，未能计算出合理的插入深度")
            
            # 验证端点向量还原： 端点位置 = 基准位置 + (旋转矩阵·Y轴) * 深度
            for p in peg_ports:
                rot_matrix = np.array(p["rotation"])
                base_origin = np.array(p["base_origin"])
                reported_pos = np.array(p["position"])
                depth = p["insertion_depth"]
                
                # 假设插销主轴在局部坐标系是 Y 轴 [0, 1, 0]
                local_axis = np.array([0.0, 1.0, 0.0])
                world_axis = rot_matrix @ local_axis
                
                # 理论上的极值端点
                calculated_pos = base_origin + world_axis * depth
                
                # 两者距离应该极小 (允许浮点数误差)
                dist = np.linalg.norm(calculated_pos - reported_pos)
                self.assertLess(dist, 1e-6, "端点投射几何推导不自洽！")

    def test_hole_port_preservation(self):
        """
        测试普通孔位 (如 32524.dat 梁孔) 是否保持原样而不被错误分裂。
        """
        response = self.client.get("/api/ldraw_part/32524?color=4")
        self.assertEqual(response.status_code, 200)
        
        data = response.json()
        ports = data.get("ports", [])
        
        self.assertTrue(len(ports) > 0, "梁应包含孔位端口")
        
        for p in ports:
            # 如果是非 peg 类型，应当保持 base_origin == position 且 insertion_depth == 0
            if "hole" in p["type"]:
                pos = np.array(p["position"])
                base = np.array(p["base_origin"])
                depth = p["insertion_depth"]
                
                self.assertEqual(depth, 0.0, "孔位不应拥有插入深度投射")
                self.assertTrue(np.allclose(pos, base), "孔位的基准点应严格等于自身位置")

    def test_peg_insertion_direction(self):
        """
        测试：用户点击插销的“长的一端”（端点A）与“短的一端”（端点B）插入孔中时，
        物理逻辑是否能正确识别方向，使得点击的一端真正没入孔中，而不是反向。
        """
        response = self.client.get("/api/ldraw_part/6558?color=4")
        self.assertEqual(response.status_code, 200)
        
        ports = response.json().get("ports", [])
        peg_ports = [p for p in ports if p["type"] == "peg"]
        
        self.assertTrue(len(peg_ports) >= 2, "至少需要有两个插销端点")
        
        # 找到属于同一个 base_origin 的两个分裂端点，一个 depth > 0，一个 depth < 0
        base_origin_str = str(peg_ports[0]["base_origin"])
        ports_same_base = [p for p in peg_ports if str(p["base_origin"]) == base_origin_str]
        
        self.assertTrue(len(ports_same_base) >= 2, "至少需要有两个从同一基准点分裂的端点")
        
        p_positive = ports_same_base[0]
        p_negative = ports_same_base[1]
        
        # 提取旋转矩阵并推导各自的有效朝向 (局部 Y 轴的世界朝向)
        rot_pos = np.array(p_positive["rotation"])
        rot_neg = np.array(p_negative["rotation"])
        
        # LDraw 插销的主轴是 Y 轴
        local_axis = np.array([0.0, 1.0, 0.0])
        axis_pos = rot_pos @ local_axis
        axis_neg = rot_neg @ local_axis
        
        # 为了让物理贴合时能使得前端对齐逻辑产生相反的姿态翻转，
        # 两者的朝向（法线）向量必须在 3D 空间中夹角为 180 度。
        dot_product = np.dot(axis_pos, axis_neg)
        self.assertAlmostEqual(dot_product, -1.0, places=4, 
                               msg="长端和短端的法线朝向必须相反，否则会导致相反的一端插入孔中！")

    def test_peg_assembly_alignment(self):
        """
        测试：模拟前端装配过程。验证当选择插销的一端插入梁孔时，
        插销能够顺着孔的方向插入，并且最终插入深度恰好等于该端点的 insertion_depth。
        证明这端是真正“插进去了”，而不是“倒拔葱”。
        """
        # 1. 提取插销数据
        res_peg = self.client.get("/api/ldraw_part/6558?color=4")
        peg_ports = [p for p in res_peg.json().get("ports", []) if p["type"] == "peg"]
        self.assertTrue(len(peg_ports) >= 2)
        
        # 选取一个拥有正向 insertion_depth 的端点（假设为长端）
        tip_port = next((p for p in peg_ports if p["insertion_depth"] > 0), None)
        self.assertIsNotNone(tip_port)
        
        tip_rot = np.array(tip_port["rotation"])
        tip_pos = np.array(tip_port["position"])
        base_origin = np.array(tip_port["base_origin"])
        depth = tip_port["insertion_depth"]
        
        # 2. 提取梁孔数据
        res_hole = self.client.get("/api/ldraw_part/32524?color=4")
        hole_ports = [p for p in res_hole.json().get("ports", []) if "hole" in p["type"]]
        self.assertTrue(len(hole_ports) > 0)
        
        hole_port = hole_ports[0]
        hole_rot = np.array(hole_port["rotation"])
        hole_pos = np.array(hole_port["position"])
        
        # 3. 模拟前端 store.ts 的 snapParts 数学对齐
        # 目标：将插销 Tip 对齐到 孔表面
        # 插销的轴向 (局部 Y)
        base_axis = np.array([0.0, 1.0, 0.0])
        tip_axis_world = tip_rot @ base_axis
        hole_axis_world = hole_rot @ base_axis
        
        # 对于插销进孔，前端通常会将插销的法线与孔的法线反向对齐 (qDelta 旋转)
        # 这里为了简化纯数学证明，我们只看沿着孔轴线 (hole_axis_world) 的平移相对关系
        
        # 依据我们新的 base_origin 逻辑，前端对齐的本质是：
        # 让 插销的 base_origin 平移到 目标孔的 base_origin (也就是孔的表面)
        
        # 假设插销完成旋转后，它的轴线 tip_axis_world 被对齐到与孔轴线 hole_axis_world 平行（或反向）
        # 我们假设插销沿着孔的方向被推进去了。
        # 此时，原来你选中的那个物理极值点 tip_pos，相对于基准点 base_origin 的位置向量是：
        tip_vector_from_base = tip_pos - base_origin
        
        # 这个向量的长度就是 depth
        self.assertAlmostEqual(np.linalg.norm(tip_vector_from_base), depth, places=5)
        
        # 关键断言：当我们把 base_origin 贴合在孔表面时，
        # tip_pos 必须位于 base_origin 的一侧，使得它能深入孔的内部！
        # 在多重端口中，端点的法线 (tip_axis_world) 是朝外的。
        # 所以沿着法线向内走，就是指向 base_origin。
        
        # 验证: (base_origin - tip_pos) 的方向，应该和端点的向内方向一致
        inward_dir = -tip_axis_world
        actual_dir = base_origin - tip_pos
        
        # 归一化后对比，证明它是顺着插进去的
        actual_dir_norm = actual_dir / np.linalg.norm(actual_dir)
        cos_theta = np.dot(inward_dir, actual_dir_norm)
        
        self.assertAlmostEqual(cos_theta, 1.0, places=4, msg="端点没有顺着孔插进去，方向错乱！")

if __name__ == "__main__":
    unittest.main()

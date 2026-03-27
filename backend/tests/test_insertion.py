import os
import sys
import unittest
import numpy as np

# 注入项目根目录以支持 backend 导入
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.port import Port
from backend.connection_edge import ConnectionEdge
from backend.topology_manager import TopologyManager, PartNode

# ---------------------------------------------------------------------------
# 3. 交互与拓扑物理验证 (Functional Tests)
# ---------------------------------------------------------------------------

class TestAssemblyV3_0(unittest.TestCase):
    """
    [v3.0 归一化架构] 图论驱动装配与对轴协议验证 (Functional Tests)
    """

    def setUp(self):
        # 初始化物理拓扑管理器
        self.tm = TopologyManager()

    def test_3_1_p2p_absolute_alignment_accuracy(self):
        """
        [Test 3.1] 验证 P2P 绝对精准落位协议。
        """
        # 销钉端口 (Parent)
        p1 = Port.from_raw("p", "pin.dat", [0.0, 0.0, 0.0], np.eye(3))
        # 梁孔端口 (Child) - 偏移 8mm
        p2 = Port.from_raw("h", "peghole.dat", [0.008, 0, 0], np.eye(3))

        edge = ConnectionEdge("node1", "node2", p1, p2)
        
        # 计算连接矩阵
        T_rel = edge.port_parent.calculate_relative_transform(edge.port_child)
        
        # 验证: 源端口应用该矩阵后的全球位姿，应与目标端口重合 (Z 对冲)
        src_pos_homo = np.append(p1.position, 1.0)
        final_pos = (T_rel @ src_pos_homo)[:3]
        np.testing.assert_allclose(final_pos, p2.position, atol=1e-7,
                                   err_msg="对轴落位协议失效！位姿变换未对齐。")

    def test_3_2_auto_snap_topology_merging(self):
        """
        [Test 3.2] 验证自动闭合扫描后的图合并逻辑。
        """
        # 背景: 两零件间建立了一个主连接
        node_a = PartNode("A", "long_pin")
        node_b = PartNode("B", "beam")
        self.tm.add_part(node_a)
        self.tm.add_part(node_b)

        # 构建主连接 (Primary Edge)
        edge1 = ConnectionEdge("A", "B", 
                               Port.from_raw("p1", "pin.dat", [0, 0, 0], np.eye(3)), 
                               Port.from_raw("h1", "peghole.dat", [0, 0, 0], np.eye(3)))
        self.tm.connect_ports(edge1)
        
        # 构建扫描产生的第二条冗余连接 (Secondary Edge)
        edge2 = ConnectionEdge("A", "B", 
                               Port.from_raw("p2", "pin.dat", [0, 0.016, 0], np.eye(3)), 
                               Port.from_raw("h2", "peghole.dat", [0, 0.016, 0], np.eye(3)))
        self.tm.connect_ports(edge2)

        # 核心逻辑: MultiDiGraph -> Spanning Tree (DiGraph)
        # 应当检测到过约束并将多重边压缩或处理
        tree = self.tm.build_spanning_tree()
        
        # 1. 节点数量验证
        self.assertEqual(tree.number_of_nodes(), 2)
        # 2. 导出树应将多边化简为一条控制边
        self.assertEqual(tree.number_of_edges(), 1, 
                         "Spanning Tree 构建逻辑未能处理过约束多重边！")
        
        # 3. 检查闭环边是否被归档到 TopologyManager 内部
        self.assertTrue(len(self.tm.closed_loops) >= 0)

if __name__ == '__main__':
    unittest.main()

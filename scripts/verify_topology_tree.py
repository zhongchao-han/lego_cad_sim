import sys
import os
import networkx as nx
import numpy as np

# [scripts/verify_topology_tree.py]
# 离线验证工具：模拟拓扑结构的 BFS 树推演与无环图生成 logic。
# 场景：A -> B -> C 链式结构。

def verify_spanning_tree():
    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    from backend.topology_manager import TopologyManager, PartNode
    from backend.port import Port
    from backend.connection_edge import ConnectionEdge

    print("[*] 正在构建拓扑链: A -> B -> C ...")
    tm = TopologyManager()
    
    # 模拟零件资产
    for i in ["A", "B", "C"]:
        tm.add_part(PartNode(i, f"beam_{i}"))

    # 建立 P2P 物理连接
    p = Port.from_raw("p", "pin.dat", [0, 0, 0], np.eye(3))
    h = Port.from_raw("h", "peghole.dat", [0, 0, 0], np.eye(3))

    tm.connect_ports(ConnectionEdge("A", "B", p, h))
    tm.connect_ports(ConnectionEdge("B", "C", p, h))

    print("[*] 启动 Spanning Tree 构建...")
    tree = tm.build_spanning_tree()

    print(f"[+] 树节点: {list(tree.nodes)}")
    print(f"[+] 树边数: {tree.number_of_edges()}")

    if tree.number_of_nodes() == 3 and tree.number_of_edges() == 2:
        print("\n[SUCCESS] 拓扑树推演符合物理逻辑。")
    else:
        print("\n[ERROR] 拓扑树异常! 节点或边数缺失。")

if __name__ == "__main__":
    verify_spanning_tree()

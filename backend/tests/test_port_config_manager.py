import unittest
import os
import json
import shutil
import tempfile
from port_config_manager import PortConfigManager

class TestPortConfigManager(unittest.TestCase):
    def setUp(self):
        # 创建临时测试目录和文件
        self.test_dir = tempfile.mkdtemp()
        self.config_path = os.path.join(self.test_dir, "test_ports.json")
        
        # 初始化测试数据
        self.sample_ports = [
            {"type": "peg", "position": [0, 0, 0], "rotation": [[1,0,0],[0,1,0],[0,0,1]]}
        ]

    def tearDown(self):
        # 清理临时目录
        # 在 Windows 上删除只读文件需要恢复权限
        for root, dirs, files in os.walk(self.test_dir):
            for f in files:
                os.chmod(os.path.join(root, f), 0o666)
        shutil.rmtree(self.test_dir)

    def test_initial_load_empty(self):
        """测试初始加载不存在的文件。"""
        manager = PortConfigManager(self.config_path)
        self.assertEqual(len(manager.get_pending_parts()), 0)

    def test_save_and_load(self):
        """测试保存并重新加载数据。"""
        manager = PortConfigManager(self.config_path)
        manager.update_part_config("6558.dat", self.sample_ports, confidence=0.8)
        manager.save()
        
        # 验证文件内容
        with open(self.config_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            self.assertIn("6558.dat", data)
            self.assertEqual(data["6558.dat"]["status"], "pending")
        
        # 重新加载
        new_manager = PortConfigManager(self.config_path)
        config = new_manager.get_part_config("6558.dat")
        self.assertIsNotNone(config)
        self.assertEqual(config["confidence"], 0.8)

    def test_metadata_lock_verified(self):
        """核心测试：verified 状态应阻止非强制更新。"""
        manager = PortConfigManager(self.config_path)
        
        # 1. 模拟人工复核
        manager.update_part_config("6558.dat", self.sample_ports, status="verified")
        manager.save()
        
        # 2. 尝试自动发现覆盖（非强制）
        new_ports = [{"type": "broken_auto_discovery", "position": [99, 99, 99]}]
        success = manager.update_part_config("6558.dat", new_ports, status="pending", force=False)
        
        self.assertFalse(success, "verified 数据不应被非强制更新覆盖")
        config = manager.get_part_config("6558.dat")
        self.assertEqual(config["status"], "verified", "状态应保持为 verified")
        self.assertEqual(config["ports"][0]["type"], "peg", "端口数据不应被篡改")

    def test_metadata_lock_force(self):
        """测试 force 参数应能强制覆盖 verified 数据。"""
        manager = PortConfigManager(self.config_path)
        manager.update_part_config("6558.dat", self.sample_ports, status="verified")
        
        new_ports = [{"type": "forced_update", "position": [0,0,0]}]
        success = manager.update_part_config("6558.dat", new_ports, force=True)
        
        self.assertTrue(success)
        config = manager.get_part_config("6558.dat")
        self.assertEqual(config["ports"][0]["type"], "forced_update")

    def test_pending_list_sorting(self):
        """测试待复核列表按自信度排序。"""
        manager = PortConfigManager(self.config_path)
        manager.update_part_config("A.dat", [], confidence=0.9) # 较自信
        manager.update_part_config("B.dat", [], confidence=0.2) # 不自信
        manager.update_part_config("C.dat", [], confidence=0.5)
        manager.update_part_config("D.dat", [], status="verified") # 已复核，不应出现在列表中
        
        pending = manager.get_pending_parts()
        self.assertEqual(len(pending), 3)
        self.assertEqual(pending[0]["part_id"], "B.dat", "最不自信的应排在首位")
        self.assertEqual(pending[-1]["part_id"], "A.dat", "最自信的应排在末位")

    def test_exception_handling_read_only(self):
        """测试文件权限异常。"""
        # 创建只读文件
        with open(self.config_path, 'w') as f:
            f.write("{}")
        os.chmod(self.config_path, 0o444) 
        
        manager = PortConfigManager(self.config_path)
        manager.update_part_config("test.dat", [])
        
        with self.assertRaises(IOError):
            manager.save()

if __name__ == "__main__":
    unittest.main()

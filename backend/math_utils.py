import numpy as np

class CoordinateTransformer:
    """
    真理来源：处理 LDraw (LDU, RHS, Y-Up) 与本项目物理空间 (Meters, RHS, Y-Up) 之间的归一化。
    遵守 v3.0 协议：Rx(180) 投影。
    """
    
    LDU_TO_SI = 0.0004  # 1 LDU = 0.4mm
    
    @staticmethod
    def get_rx180() -> np.ndarray:
        """返回 Rx(180) 翻转矩阵：x -> x, y -> -y, z -> -z"""
        return np.array([
            [1, 0, 0],
            [0, -1, 0],
            [0, 0, -1]
        ], dtype=np.float64)

    @staticmethod
    def normalize_pos(pos_ldu: np.ndarray) -> np.ndarray:
        """
        [Test 1.1] 将 LDU 原始坐标投影到归一化物理空间。
        公式：Pos_SI = (Rx180 @ Pos_LDU) * 0.0004
        """
        arr = np.asanyarray(pos_ldu, dtype=np.float64)
        # Rx180 @ [x, y, z] -> [x, -y, -z]
        res = arr.copy()
        res[1] = -res[1]
        res[2] = -res[2]
        return res * CoordinateTransformer.LDU_TO_SI

    @staticmethod
    def normalize_rot(rot_ldu: np.ndarray) -> np.ndarray:
        """
        [Test 1.1] 将 LDU 原始旋转矩阵转换到归一化物理旋转。
        公式：Rot_SI = Rx180 @ Rot_LDU @ Rx180
        """
        rx180 = CoordinateTransformer.get_rx180()
        return rx180 @ rot_ldu @ rx180

    @staticmethod
    def purify_matrix(mat: np.ndarray) -> np.ndarray:
        """
        [Test 1.2] Gram-Schmidt 正交化，剔除 LDraw 中常见的剪切畸变。
        """
        m = np.asanyarray(mat[:3, :3], dtype=np.float64)
        u, s, vh = np.linalg.svd(m)
        return u @ vh

def purify_rotation_matrix(m: np.ndarray) -> np.ndarray:
    """兼容性包装器"""
    return CoordinateTransformer.purify_matrix(m)

def matrix_to_list(m: np.ndarray) -> list:
    """工具函数：矩阵转嵌套列表"""
    return m.tolist()

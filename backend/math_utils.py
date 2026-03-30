import numpy as np
import logging

logger = logging.getLogger(__name__)


class CoordinateTransformer:
    """
    真理来源：处理 LDraw (LDU, RHS, Y-Up) 与本项目物理空间 (Meters, RHS, Y-Up) 之间的归一化。
    遵守 v3.0 协议：Rx(180) 投影。
    """

    LDU_TO_SI = 0.0004  # 1 LDU = 0.4mm

    @staticmethod
    def get_rx180() -> np.ndarray:
        """返回 Rx(180) 翻转矩阵：x -> x, y -> -y, z -> -z"""
        return np.array([[1, 0, 0], [0, -1, 0], [0, 0, -1]], dtype=np.float64)

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
    def purify_rotation_matrix(m: np.ndarray) -> np.ndarray:
        """
        [v3.0 物理核心] 强制执行 Gram-Schmidt 正交化并确保右手系 (det=1.0)。
        """
        logger.debug(f"[DEBUG] 进入 purify_rotation_matrix: dtype={m.dtype}")
        # 补丁：强制转换为 float64 以避免 numpy 对 int32 数组进行原位浮点除法时崩溃
        m = m.astype(np.float64)
        m = np.nan_to_num(m, nan=0.0).copy()

        # 1. 确保 X 轴向量非零
        vx = m[:, 0]
        norm_x = np.linalg.norm(vx)
        if norm_x < 1e-6:
            vx = np.array([1.0, 0, 0])
        else:
            vx /= norm_x

        # 2. 正交化 Y 轴
        vy = m[:, 1]
        vy = vy - np.dot(vy, vx) * vx
        norm_y = np.linalg.norm(vy)
        if norm_y < 1e-6:
            vy = np.array([0, 1.0, 0])
        else:
            vy /= norm_y

        # 3. 强制右手系 (Z = X cross Y)
        vz = np.cross(vx, vy)

        res = np.column_stack((vx, vy, vz))
        return res

    @staticmethod
    def purify_matrix(m: np.ndarray) -> np.ndarray:
        """兼容性别名：统一重定向到 purify_rotation_matrix"""
        return CoordinateTransformer.purify_rotation_matrix(m)


def purify_rotation_matrix(m: np.ndarray) -> np.ndarray:
    """全局别名：调用 CoordinateTransformer 的右手正交化逻辑"""
    return CoordinateTransformer.purify_rotation_matrix(m)


def purify_matrix(m: np.ndarray) -> np.ndarray:
    """全局别名：统一重定向到 CoordinateTransformer.purify_matrix"""
    return CoordinateTransformer.purify_matrix(m)


def matrix_to_list(m: np.ndarray) -> list:
    """工具函数：矩阵转嵌套列表"""
    return m.tolist()

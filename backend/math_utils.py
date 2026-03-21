import numpy as np

def purify_rotation_matrix(rot: np.ndarray) -> np.ndarray:
    """
    使用 Gram-Schmidt 正交化算法，确保旋转矩阵是严格正交且右手的（行列式为 1）。
    这消除了由于浮点舍入、手动输入或不正确的 LDraw 反射缩放引起的偏离。
    """
    if not isinstance(rot, np.ndarray):
        rot = np.array(rot)
    
    # 将输入重塑为 3x3 (如果它是 1D 数组的话)
    rot = rot.reshape(3, 3)

    # 1. 执行 Gram-Schmidt 过程
    v1 = rot[:, 0]
    v2 = rot[:, 1]
    
    # 归一化 X 轴
    u1 = v1 / np.linalg.norm(v1)
    
    # 令 Y 轴与 X 轴正交
    u2 = v2 - np.dot(u2 := v2, u1) * u1
    u2 = u2 / np.linalg.norm(u2)
    
    # 通过叉积计算 Z 轴，强制产生右手坐标系 (Right-Handed System)
    # 这也自动确保了 Z 轴与 X, Y 轴正交，且长度为 1
    u3 = np.cross(u1, u2)
    
    # 重新构建矩阵 (按列拼接)
    pure_rot = np.column_stack((u1, u2, u3))
    
    # 2. 健壮性检查：强制处理极微小的数值漂移
    # 再次验证行列式是否为 1 (如果发生了镜像反射，行列式会是 -1)
    det = np.linalg.det(pure_rot)
    if det < 0:
        # 如果是左手系，翻转 Z 轴以恢复右手系
        pure_rot[:, 2] *= -1
        
    return pure_rot

def matrix_to_list(mat: np.ndarray) -> list:
    """辅助函数：将 numpy 矩阵转为标准 Python 嵌套列表以供 JSON 序列化。"""
    return mat.tolist()

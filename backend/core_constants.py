"""
core_constants.py
=================
定义全系统公用的物理与几何常数。
强制标准：
- [Meters] 代表 SI 米制单位，用于物理仿真与持久化存储。
- [LDU] 代表乐高原始单位，用于 LDraw 文件解析与前端 3D 渲染空间。
"""

# 全栈核心转换常数: 1 LDU = 0.4mm = 0.0004m
LDU_TO_METERS: float = 0.0004
METERS_TO_LDU: float = 2500.0

# 乐高标准的 20-LDU 物理格点 (即 8mm)
LEGO_GRID_LDU: float = 20.0
HALF_GRID_LDU: float = 10.0

# 转换为 SI 物理空间的格点间距 [Meters]
LEGO_GRID_METERS: float = 0.008
HALF_GRID_METERS: float = 0.004

LDU = LDU_TO_METERS # 向后兼容
LDU_TO_SI = LDU_TO_METERS # 向后兼容

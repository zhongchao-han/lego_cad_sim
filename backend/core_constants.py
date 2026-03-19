"""
core_constants.py
=================
定义全系统公用的物理与几何常数。
"""

# LDraw 单位转换：1 LDU = 0.4mm = 0.0004m
LDU: float = 0.0004
LDU_TO_SI: float = 0.0004

# 零件端口排布精度 (乐高标准格点)
LEGO_GRID_LDU: float = 20.0
HALF_GRID_LDU: float = 10.0

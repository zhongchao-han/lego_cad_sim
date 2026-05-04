"""
LDraw 零件分类启发式 (L50 分级目录)
====================================
从 .dat 首行注释解析的零件描述名映射到顶层 category 桶。

设计取舍：
- 不依赖 LDraw 官方 categories.txt（仓库不强依赖第三方数据文件，所有规则在代码里）。
- 顺序敏感的关键词匹配 —— "Axle Pin" 必须先被 Pin 截走，不能进 Axle 桶。
- 全库 1942 个 part 启发式跑下来约 16% 落 "Other"，v1 可接受；后续按需细化。

配套：
- backend/sync_meili.py 用 categorize() 把 category 字段写入 Meili 倒排索引
- backend/server.py /api/get_verified_parts 同样调用，让前端无需重读 .dat
"""
from __future__ import annotations

import functools
import logging
import os
from typing import Tuple

logger = logging.getLogger(__name__)

# 前端 PartLibraryPanel 折叠面板的 "正常" 显示顺序（从上到下）。
# "Frequent"（用过的）由前端注入到顶部，不在此列表内。
CATEGORY_ORDER: Tuple[str, ...] = (
    'Pin', 'Axle', 'Connector', 'Beam', 'Gear', 'Wheel',
    'Plate', 'Tile', 'Brick', 'Panel',
    'Cylinder', 'Pneumatic', 'Steering', 'Electric',
    'Sticker', 'Other',
)

# 顺序敏感：先检最具体的（Connector / Pin 都早于 Axle，避免 "Axle Pin" 走错桶）。
# 关键词匹配大小写无关；外层 categorize() 已把输入 lowercase。
_RULES: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ('Sticker',   ('sticker',)),
    ('Electric',  ('motor', 'servo', 'electric', 'battery')),
    ('Pneumatic', ('pneumatic', 'hose', 'flex ', 'tubing')),
    ('Steering',  ('steering',)),
    ('Connector', ('connector',)),
    ('Pin',       ('pin',)),
    ('Gear',      ('gear', 'tooth')),
    ('Wheel',     ('wheel', 'tire', 'tyre')),
    ('Axle',      ('axle',)),
    ('Beam',      ('beam', 'liftarm')),
    ('Panel',     ('panel', 'fairing')),
    ('Brick',     ('brick', 'block')),
    ('Plate',     ('plate', 'baseplate')),
    ('Tile',      ('tile',)),
    ('Cylinder',  ('cylinder', 'shock', 'absorber')),
)


def categorize(name: str) -> str:
    """把 LDraw 零件名分到 CATEGORY_ORDER 中的某个桶。

    LDraw 首行注释里偶尔以 ``~`` 或 ``=`` 开头表示 unofficial / placeholder，
    需要先剥离避免它们污染 keyword 匹配。
    """
    if not name:
        return 'Other'
    cleaned = name.lstrip('~=').lower()
    for cat, keywords in _RULES:
        if any(kw in cleaned for kw in keywords):
            return cat
    return 'Other'


@functools.lru_cache(maxsize=4096)
def get_part_name(part_id: str, ldraw_parts_dir: str) -> str:
    """读取 .dat 首行注释作为零件可读名称；找不到时退化为 part_id 自身。

    1942 个 part * 反复请求 -> lru_cache 摊销磁盘 IO。"""
    if not part_id:
        return ''
    path = os.path.join(ldraw_parts_dir, part_id)
    if not os.path.exists(path):
        return part_id
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            first_line = f.readline().strip()
        if first_line.startswith('0 '):
            return first_line[2:].strip()
    except (OSError, ValueError) as exc:
        logger.warning("[category] failed to read %s: %s", path, exc)
    return part_id


def categorize_part(part_id: str, ldraw_parts_dir: str) -> Tuple[str, str]:
    """便捷：从 part_id + ldraw 根目录一步拿到 (name, category)。"""
    name = get_part_name(part_id, ldraw_parts_dir)
    return name, categorize(name)

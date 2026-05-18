"""
plug_clustering.py
==================
走法 A 期 A2 — plug-level 启发式聚类。把 site/port 元数据聚合为
plug（用户视角下的"整片 stud" / "销头销尾分明" / "整排孔贯通合并"）。

启发式（v1，详见 docs/02_system_design/01_assembly_logic_and_algorithms.md
未来增节）：

  1. 同 Gender + 同 Profile + 同法线方向（dot > 0.95）分组
  2. 几何聚类：方差最大轴排序 + 动态 max-gap split（max_gap > 2× median_gap 切）
  3. FEMALE 反向法线 + 法线平面投影位置重合 → 合并贯通孔
     （MALE 不合：销两端独立物理）
  4. label 启发式：face × type_class（face=top/bottom/±x/±z/oblique）

baseline 全过：2x4 plate=2 plug / 2780 销=2 plug / 9-hole beam=1 plug。
全 2144 part 0 个 fallback hash 命名。

不依赖 pybullet / numpy 之外的库；可在 server / scripts / 单测三处复用。
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# ─── 常量（与 frontend/src/utils/fitMath.ts 同源） ────────────────────────────
GENDER_FEMALE = "FEMALE"
GENDER_MALE = "MALE"
PROFILE_CYL = "CYL"
PROFILE_CROSS = "CROSS"
PROFILE_STUD = "STUD"

# 启发式参数
NORMAL_DOT_THRESHOLD = 0.95           # 同方向 dot 阈值（约 18° 夹角内视为同向）
SAME_POSITION_THRESHOLD = 0.0001      # 0.1mm — site_utils SITE_MERGE_THRESHOLD 同源
DUAL_FACE_PROJECTION_THRESHOLD = 0.0005  # 0.5mm — 法线平面投影位置容差（贯通孔板厚噪声吸收）
MAX_GAP_RATIO = 2.0                   # 动态 max-gap split 阈值


def _get_gender_profile(port_type: str) -> Tuple[Optional[str], Optional[str]]:
    """跟 frontend/src/utils/fitMath.ts INTERFACE_REGISTRY 同源的 gender/profile 判定。
    优先级：axlehole > tube > stud > axle > peg/pin/confric > hole（兜底）。"""
    t = port_type.lower()
    if t.endswith(".dat"):
        t = t[:-4]
    if "axlehole" in t or "axlehol" in t:
        return GENDER_FEMALE, PROFILE_CROSS
    if "tube" in t:
        return GENDER_FEMALE, PROFILE_STUD
    if "stud" in t:
        return GENDER_MALE, PROFILE_STUD
    if "hole" in t or "hol" in t:
        return GENDER_FEMALE, PROFILE_CYL
    if "axle" in t:
        return GENDER_MALE, PROFILE_CROSS
    if any(x in t for x in ("peg", "pin", "connect", "confric", "halfpin")):
        return GENDER_MALE, PROFILE_CYL
    return None, None


def _normalize_vec(v: Tuple[float, float, float]) -> Tuple[float, float, float]:
    norm = math.sqrt(sum(x * x for x in v))
    if norm < 1e-9:
        return (0.0, 0.0, 0.0)
    return (v[0] / norm, v[1] / norm, v[2] / norm)


def _dot3(a: Tuple[float, float, float], b: Tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _dist3(a: Tuple[float, float, float], b: Tuple[float, float, float]) -> float:
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


@dataclass
class _FlatPort:
    """临时数据结构 — 把 sites 展平成单 port 列表喂启发式。"""
    site_id: str
    port_idx: int                         # 在 site.ports[] 中的位置
    port_type: str
    position: Tuple[float, float, float]
    normal: Tuple[float, float, float]    # rotation 第三列归一化
    gender: str
    profile: str


@dataclass
class Plug:
    """plug 视图 — 走法 A 期 A2 的核心抽象。"""
    plug_id: str
    label: str
    gender: str
    profile: str
    direction: Tuple[float, float, float]
    # plug 包含的 (site_id, port_idx_in_site) 二元组
    members: List[Tuple[str, int]] = field(default_factory=list)

    @property
    def port_count(self) -> int:
        return len(self.members)

    @property
    def site_ids(self) -> List[str]:
        """去重 + 排序的 site id 列表（同 site 多 port 在不同 plug 时只出现一次）。"""
        return sorted(set(s for s, _ in self.members))

    def to_dict(self) -> Dict:
        return {
            "plug_id": self.plug_id,
            "label": self.label,
            "gender": self.gender,
            "profile": self.profile,
            "direction": list(self.direction),
            "members": [list(m) for m in self.members],
            "port_count": self.port_count,
            "site_ids": self.site_ids,
        }


def _flatten_ports(sites: List[dict]) -> List[_FlatPort]:
    flat: List[_FlatPort] = []
    for site in sites:
        for idx, port in enumerate(site.get("ports", [])):
            r = port.get("rotation", [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
            try:
                normal = _normalize_vec((r[0][2], r[1][2], r[2][2]))
            except (IndexError, TypeError):
                continue
            g, p = _get_gender_profile(port.get("type", ""))
            if g is None or p is None:
                continue
            pos_raw = port.get("position", site.get("position", [0, 0, 0]))
            position: Tuple[float, float, float] = (pos_raw[0], pos_raw[1], pos_raw[2])
            flat.append(_FlatPort(
                site_id=site["id"], port_idx=idx,
                port_type=port["type"], position=position, normal=normal,
                gender=g, profile=p,
            ))
    return flat


def _group_by_direction(flat_ports: List[_FlatPort]) -> Dict[Tuple, List[_FlatPort]]:
    """按 (gender, profile, 量化法线方向) 分组。同 (gender, profile) 内多个方向各自一组。"""
    groups: Dict[Tuple, List[_FlatPort]] = defaultdict(list)
    for fp in flat_ports:
        key_base = (fp.gender, fp.profile)
        candidates = [k for k in groups if k[:2] == key_base]
        matched = None
        for cand in candidates:
            if _dot3(fp.normal, cand[2]) > NORMAL_DOT_THRESHOLD:
                matched = cand
                break
        if matched is None:
            matched = (fp.gender, fp.profile, fp.normal)
        groups[matched].append(fp)
    return groups


def _geometric_split(group: List[_FlatPort]) -> List[List[_FlatPort]]:
    """递归：沿方差最大轴排序 + 动态 max-gap split。
    max_gap > MAX_GAP_RATIO × median_gap 时切；否则不动。"""
    if len(group) <= 1:
        return [group]
    positions = [fp.position for fp in group]
    means = [sum(p[i] for p in positions) / len(positions) for i in range(3)]
    variances = [sum((p[i] - means[i]) ** 2 for p in positions) for i in range(3)]
    sort_axis = variances.index(max(variances))
    sorted_group = sorted(group, key=lambda fp: fp.position[sort_axis])
    gaps = [
        _dist3(sorted_group[i].position, sorted_group[i - 1].position)
        for i in range(1, len(sorted_group))
    ]
    if not gaps:
        return [sorted_group]
    median_gap = sorted(gaps)[len(gaps) // 2]
    max_gap = max(gaps)
    if median_gap < 1e-9 or max_gap <= MAX_GAP_RATIO * median_gap:
        return [sorted_group]
    split_idx = gaps.index(max_gap) + 1
    return _geometric_split(sorted_group[:split_idx]) + _geometric_split(sorted_group[split_idx:])


def _project_to_plane(p: Tuple[float, float, float],
                      n: Tuple[float, float, float]) -> Tuple[float, float, float]:
    """把点 p 投影到法线 n 垂直的平面：p_proj = p - (p · n) * n。"""
    d = _dot3(p, n)
    return (p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2])


def _sites_position_match(plug_a: List[_FlatPort], plug_b: List[_FlatPort]) -> bool:
    """贯通孔双面位置匹配：法线平面投影距离 < 0.5mm。
    忽略沿法线方向的距离（= 板厚），只看法线平面内的位置。"""
    if not plug_a or not plug_b or len(plug_a) != len(plug_b):
        return False
    n = plug_a[0].normal
    matched_b = set()
    for fa in plug_a:
        pa_proj = _project_to_plane(fa.position, n)
        found = False
        for jb, fb in enumerate(plug_b):
            if jb in matched_b:
                continue
            if _dist3(pa_proj, _project_to_plane(fb.position, n)) < DUAL_FACE_PROJECTION_THRESHOLD:
                matched_b.add(jb)
                found = True
                break
        if not found:
            return False
    return True


def _merge_female_dual_face(initial_plugs: List[Tuple[List[_FlatPort], str, str, Tuple]]) -> List[Tuple[List[_FlatPort], str, str, Tuple]]:
    """FEMALE plug 反向法线 + 法线平面位置重合 → 合并贯通孔。MALE 不合。"""
    merged: List[Tuple[List[_FlatPort], str, str, Tuple]] = []
    used: set = set()
    for i, (plug_a, ga, pa, na) in enumerate(initial_plugs):
        if i in used:
            continue
        used.add(i)
        if ga != GENDER_FEMALE:
            merged.append((plug_a, ga, pa, na))
            continue
        partner = None
        for j, (plug_b, gb, pb, nb) in enumerate(initial_plugs):
            if j <= i or j in used:
                continue
            if gb != GENDER_FEMALE or pb != pa:
                continue
            if _dot3(na, nb) > -NORMAL_DOT_THRESHOLD:  # 必须反向：dot < -0.95
                continue
            if not _sites_position_match(plug_a, plug_b):
                continue
            partner = j
            break
        if partner is None:
            merged.append((plug_a, ga, pa, na))
        else:
            combined = plug_a + initial_plugs[partner][0]
            merged.append((combined, ga, pa, na))
            used.add(partner)
    return merged


# face 命名约定：(axis → (-side, +side))
# Y 轴用 top/bottom，X/Z 用 ±x/±z（保持向后兼容 — 之前 face 关键词就这样）。
# 跨 plug 排名时：centroid 较小的一侧用 -side 名（bottom / -x / -z），较大用 +side（top / +x / +z）。
_AXIS_FACE_NAMES: Dict[str, Tuple[str, str]] = {
    "x": ("-x", "+x"),
    "y": ("bottom", "top"),
    "z": ("-z", "+z"),
}
_AXIS_INDEX: Dict[str, int] = {"x": 0, "y": 1, "z": 2}
_FACE_EPSILON = 1e-6  # 1 micron — 区分"真同位置"和"有几何分离"


def _primary_axis(direction: Tuple[float, float, float]) -> str:
    """direction 的主轴 — y/x/z 之一，斜面返 'oblique'。"""
    nx, ny, nz = direction
    if abs(ny) > 0.9:
        return "y"
    if abs(nx) > 0.9:
        return "x"
    if abs(nz) > 0.9:
        return "z"
    return "oblique"


def _plug_centroid(plug_ports: List[_FlatPort]) -> Tuple[float, float, float]:
    """plug member 的几何重心（part 局部坐标）。"""
    n = len(plug_ports)
    cx = sum(p.position[0] for p in plug_ports) / n
    cy = sum(p.position[1] for p in plug_ports) / n
    cz = sum(p.position[2] for p in plug_ports) / n
    return (cx, cy, cz)


def _assign_face_labels(
    plugs_meta: List[Tuple[List[_FlatPort], str, str, Tuple[float, float, float]]],
) -> List[str]:
    """跨 plug face label 分配 — 修 Bug 2（170 plug 标签反了）。

    旧逻辑：每个 plug 独立按 direction 符号定 face（"+Y → top"）。这在多个同方向
    plug 共存时会重名，且对 LDraw 那种 part-local 坐标系约定模糊的情况会出反直觉
    标签（170 Gearbox：直接按 direction 给出 top_studs / bottom_studs，跟视觉位
    置上下颠倒）。

    新逻辑：按主轴分组，组内按 centroid 沿该轴排名；最小坐标 → -side 名（bottom/
    -x/-z），最大 → +side 名（top/+x/+z）。退化路径：
      - 单 plug：centroid 偏离原点 → 按 centroid 符号；卡原点 → 按 direction 符号
      - 多 plug centroid 几乎相同（销两端共原点等）→ 各自按 direction 符号兜底
      - 3+ plug：极端用 -side/+side，中间用 mid_<axis><rank> 区分
    """
    n_plugs = len(plugs_meta)
    faces: List[Optional[str]] = [None] * n_plugs
    centroids = [_plug_centroid(pm[0]) for pm in plugs_meta]

    by_axis: Dict[str, List[int]] = defaultdict(list)
    for i, (_pports, _g, _p, direction) in enumerate(plugs_meta):
        by_axis[_primary_axis(direction)].append(i)

    for axis, idxs in by_axis.items():
        if axis == "oblique":
            for i in idxs:
                faces[i] = "oblique"
            continue
        ai = _AXIS_INDEX[axis]
        minus_name, plus_name = _AXIS_FACE_NAMES[axis]

        if len(idxs) == 1:
            i = idxs[0]
            c_val = centroids[i][ai]
            if abs(c_val) < _FACE_EPSILON:
                # 单 plug 卡原点 — 用 direction 符号兜底
                dir_val = plugs_meta[i][3][ai]
                faces[i] = plus_name if dir_val > 0 else minus_name
            else:
                faces[i] = plus_name if c_val > 0 else minus_name
            continue

        # 多 plug：先看 centroid 是否真有分离；同位置则各自按 direction 兜底
        sorted_idxs = sorted(idxs, key=lambda i: centroids[i][ai])
        spread = centroids[sorted_idxs[-1]][ai] - centroids[sorted_idxs[0]][ai]
        if spread < _FACE_EPSILON:
            for i in idxs:
                dir_val = plugs_meta[i][3][ai]
                faces[i] = plus_name if dir_val > 0 else minus_name
            continue

        n = len(sorted_idxs)
        for rank, i in enumerate(sorted_idxs):
            if rank == 0:
                faces[i] = minus_name
            elif rank == n - 1:
                faces[i] = plus_name
            else:
                faces[i] = f"mid_{axis}{rank}"

    # 静态类型完整性 — 上面 4 个 branch 全覆盖
    return [f if f is not None else "unknown" for f in faces]


def _label_plug(plug_ports: List[_FlatPort], gender: str, profile: str,
                face: str, idx: int) -> str:
    """plug label = face × type_class（stud/holes/axle_holes/...）。

    face 由 `_assign_face_labels` 跨 plug 拍板传入（不再每 plug 独立看 direction）。
    label 仅供调试 / UX 显示。plug_id 始终是 deterministic hash 形式，跨 bake 稳定。
    """
    types = set(fp.port_type for fp in plug_ports)
    primary = next(iter(types)).lower()
    if primary.endswith(".dat"):
        primary = primary[:-4]

    if "stud" in primary:
        cls = "studs"
    elif "tube" in primary:
        cls = "tubes"
    elif "axlehole" in primary or "axlehol" in primary:
        cls = "axle_holes"
    elif "hole" in primary or "hol" in primary:
        cls = "holes"
    elif "axle" in primary:
        cls = "axles"
    elif any(x in primary for x in ("peg", "pin", "confric", "connect", "halfpin")):
        cls = "pin_end"
    else:
        return f"plug_{idx}"

    # MALE 销特殊命名（face 用方向表达"哪一端"）
    if gender == GENDER_MALE and profile == PROFILE_CYL and len(plug_ports) <= 2 and cls == "pin_end":
        return f"{face}_pin_end"

    return f"{face}_{cls}"


def compute_plugs(sites: List[dict], part_id: str) -> List[Plug]:
    """主入口。给 part 的 sites（json 数据格式 dict 列表）算 plug 列表。

    Args:
        sites: ldraw_port_configs.json 中 cfg['sites'] 字段。
        part_id: 用于生成 plug_id 前缀。

    Returns:
        Plug 列表，按内部确定性顺序（不保证语义稳定，但跨同次调用稳定）。
    """
    flat = _flatten_ports(sites)
    if not flat:
        return []
    groups = _group_by_direction(flat)
    initial: List[Tuple[List[_FlatPort], str, str, Tuple]] = []
    for (gender, profile, direction), group in groups.items():
        for cluster in _geometric_split(group):
            initial.append((cluster, gender, profile, direction))
    merged = _merge_female_dual_face(initial)
    faces = _assign_face_labels(merged)

    plugs: List[Plug] = []
    for idx, ((plug_ports, gender, profile, direction), face) in enumerate(zip(merged, faces)):
        plug = Plug(
            plug_id=f"{part_id}_plug_{idx}",
            label=_label_plug(plug_ports, gender, profile, face, idx),
            gender=gender,
            profile=profile,
            direction=tuple(round(d, 4) for d in direction),
            members=[(fp.site_id, fp.port_idx) for fp in plug_ports],
        )
        plugs.append(plug)
    return plugs

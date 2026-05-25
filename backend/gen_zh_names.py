"""
生成零件中文名 + 中文描述
==========================
LDraw .dat 首行英文名高度结构化（"Technic <类型> <尺寸> <修饰> with <特征>"），
用术语表做规则翻译即可一致地覆盖全量 2144 个零件，不必逐条人工翻译。

产物：data/part_names_zh.json —— { "3673.dat": {"zh_name": "...", "zh_desc": "..."}, ... }
  - zh_name：简洁主名（列表卡片显示），核心类型 + 尺寸 + 至多两个关键修饰
  - zh_desc：完整中文串（搜索可命中 + tooltip 说明），整串术语表翻译

混合策略：规则翻译打底，OVERRIDES 字典对高频常用件给更自然的人工译名。
可重复运行：以后 ldraw_port_configs.json 新增零件，重跑本脚本即可补齐。

用法：python -m backend.gen_zh_names
"""
from __future__ import annotations

import json
import os
import re

from backend.category import get_part_name as _get_part_name

_HERE = os.path.dirname(__file__)
DATA_FILE = os.path.join(_HERE, "..", "data", "ldraw_port_configs.json")
OUT_FILE = os.path.join(_HERE, "..", "data", "part_names_zh.json")
_LDRAW_LIB_ROOT = os.environ.get(
    "LDRAW_PARTS_ROOT", os.path.join(_HERE, "..", "ldraw_lib")
)
LDRAW_PARTS_DIR = os.path.join(_LDRAW_LIB_ROOT, "parts")

# ── 核心类型词（决定 zh_name 主名）─────────────────────────────────────────
# 顺序敏感：长词组 / 更具体的在前，避免 "Axle Pin" 被 "Pin" 截走、"Gear Rack" 被
# "Gear" 截走。lowercase 子串匹配。
TYPE_TERMS: list[tuple[str, str]] = [
    ("shock absorber", "减震器"),
    ("steering wheel", "转向盘"),
    ("steering", "转向件"),
    ("ball joint", "球关节"),
    ("axle and pin connector", "轴销连接器"),
    ("axle pin", "轴销"),
    ("pin connector", "销连接器"),
    ("axle connector", "轴连接器"),
    ("angle connector", "角度连接器"),
    ("connector", "连接器"),
    ("liftarm", "举臂"),
    ("beam", "梁"),
    ("worm", "蜗杆"),
    ("gear rack", "齿条"),
    ("rack", "齿条"),
    ("gear", "齿轮"),
    ("sprocket", "链轮"),
    ("pulley", "滑轮"),
    ("tire", "轮胎"),
    ("tyre", "轮胎"),
    ("wheel", "车轮"),
    ("axle", "轴"),
    ("pin", "销"),
    ("baseplate", "底板"),
    ("plate", "平板"),
    ("tile", "平滑片"),
    ("brick", "砖"),
    ("fairing", "整流罩"),
    ("panel", "面板"),
    ("cylinder", "气缸"),
    ("hose", "软管"),
    ("servo motor", "伺服马达"),
    ("motor", "马达"),
    ("pneumatic", "气动件"),
    ("sticker", "贴纸"),
    ("hub", "轮毂"),
    ("chain", "链条"),
    ("tread", "履带"),
    ("link", "链节"),
    ("bushing", "衬套"),
    ("bush", "衬套"),
    ("cam", "凸轮"),
    ("knob", "旋钮"),
    ("lever", "拉杆"),
    ("frame", "框架"),
    ("claw", "夹爪"),
    ("hook", "挂钩"),
    ("arm", "臂"),
    ("joint", "关节"),
    ("bearing", "轴承"),
    ("case", "外壳"),
    ("block", "块"),
    ("ball", "球"),
]

# ── 修饰 / 特征词（zh_desc 全文翻译 + zh_name 关键修饰）────────────────────
# 同样长词组优先。
MOD_TERMS: list[tuple[str, str]] = [
    ("power functions", "动力组"),
    ("with friction", "带摩擦"),
    ("without friction", "无摩擦"),
    ("friction", "摩擦"),
    ("axle hole", "轴孔"),
    ("axle holes", "轴孔"),
    ("pin hole", "销孔"),
    ("pinhole", "销孔"),
    ("peghole", "销孔"),
    ("pegholes", "销孔"),
    ("with holes", "带孔"),
    ("with hole", "带孔"),
    ("holes", "孔"),
    ("hole", "孔"),
    ("with slots", "带槽"),
    ("slots", "槽"),
    ("slot", "槽"),
    ("smooth", "光滑"),
    ("reinforced", "加强"),
    ("with stop", "带止位"),
    ("with knob", "带旋钮"),
    ("notched", "带槽口"),
    ("with notch", "带槽口"),
    ("towball", "拖球"),
    ("double", "双"),
    ("triple", "三联"),
    ("quadruple", "四联"),
    ("single", "单"),
    ("half", "半"),
    ("angled", "带角度"),
    ("angle", "角度"),
    ("bent", "弯折"),
    ("offset", "偏置"),
    ("perpendicular", "垂直"),
    ("transverse", "横向"),
    ("long", "长"),
    ("short", "短"),
    ("round", "圆形"),
    ("square", "方形"),
    ("flexible", "柔性"),
    ("flex", "柔性"),
    ("rubber", "橡胶"),
    ("spring", "弹簧"),
    ("thin", "薄"),
    ("thick", "厚"),
    ("axles", "轴"),
    ("one", "单"),
    ("at", "于"),
    # ── 长尾高频名词补充（按词频补，显著降低 desc 残留英文）──
    ("action figure", "人偶"),
    ("needs work", "待完善"),
    ("axlehole", "轴孔"),
    ("two flanges", "双法兰"),
    ("mudguard", "挡泥板"),
    ("competition", "竞赛"),
    ("actuator", "作动器"),
    ("extended", "加长"),
    ("complete", "总成"),
    ("system", "系统"),
    ("piston", "活塞"),
    ("pattern", "图案"),
    ("arched", "拱形"),
    ("bulges", "凸起"),
    ("quarter", "四分之一"),
    ("bluish", "偏蓝"),
    ("flanges", "法兰"),
    ("flange", "法兰"),
    ("figure", "人偶"),
    ("pump", "泵"),
    ("tube", "管"),
    ("body", "主体"),
    ("base", "底座"),
    ("dark", "深"),
    ("light", "浅"),
    ("pins", "销"),
    ("power", "电力"),
    ("two", "二"),
    ("three", "三"),
    ("four", "四"),
    ("on", "在"),
    ("gearbox", "变速箱"),
    ("background", "背景"),
    ("compressed", "压缩"),
    ("linear", "直线"),
    ("joiner", "接合件"),
    ("formed", "成型"),
    ("curved", "弯曲"),
    ("blade", "叶片"),
    ("disc", "圆盘"),
    ("arrow", "箭头"),
    ("cross", "十字"),
    ("danger", "危险"),
    ("logo", "标志"),
    ("stripes", "条纹"),
    ("stripe", "条纹"),
    ("open", "开口"),
    ("side", "侧"),
    ("medium", "中"),
    ("wide", "宽"),
    ("large", "大"),
    ("small", "小"),
    ("back", "后"),
    ("front", "前"),
    ("technical", "技术"),
    ("studs", "凸点"),
    ("stud", "凸点"),
    ("socket", "插孔"),
    ("valve", "阀"),
    ("ribbed", "带肋"),
    ("segment", "段"),
    ("ports", "端口"),
    ("port", "端口"),
    ("cannon", "炮"),
    ("rotation", "旋转"),
    ("leaning", "倾斜"),
    ("silver", "银"),
    ("ring", "环"),
    ("head", "头"),
    ("cap", "盖"),
    ("rod", "杆"),
    ("of", "的"),
    ("centre", "中心"),
    ("center", "中心"),
    ("ends", "端"),
    ("end", "端"),
    ("both", "两"),
    ("top", "顶"),
    ("bottom", "底"),
    ("left", "左"),
    ("right", "右"),
    ("type", "型"),
    ("degrees", "度"),
    ("degree", "度"),
    ("tooth", "齿"),
    ("bevel", "锥齿"),
    ("crown", "冠状"),
    ("clutch", "离合"),
    ("grabber", "抓取"),
    ("obsolete", "已弃用"),
    ("black", "黑"),
    ("white", "白"),
    ("red", "红"),
    ("grey", "灰"),
    ("gray", "灰"),
    ("blue", "蓝"),
    ("yellow", "黄"),
    ("green", "绿"),
    ("electric", "电动"),
    ("nexo", "Nexo"),
    ("shield", "盾牌"),
    ("technic", "科技"),
    ("with", "带"),
    ("without", "不带"),
    ("and", "和"),
    ("for", "用于"),
]

# zh_name 里值得保留的"显著修饰"（其余修饰只进 zh_desc，避免主名过长）。
SALIENT_MODS = {
    "带摩擦", "无摩擦", "带孔", "带槽", "光滑", "加强", "长", "短",
    "带角度", "弯折", "柔性", "橡胶", "锥齿", "已弃用",
}

# 长词组优先的合并表（zh_desc 用）。
_ALL_TERMS = sorted(TYPE_TERMS + MOD_TERMS, key=lambda kv: -len(kv[0]))

# ── 手工 override：高频常用件给更自然的人工译名 ──────────────────────────
OVERRIDES: dict[str, dict[str, str]] = {
    "2780.dat":   {"zh_name": "摩擦销 2L", "zh_desc": "带摩擦的标准连接销，两端各插入一个销孔，是最常用的固定连接件（蓝色）。"},
    "3673.dat":   {"zh_name": "光销 2L", "zh_desc": "无摩擦的标准连接销，可自由转动，常用作铰接轴（浅灰色）。"},
    "43093.dat":  {"zh_name": "轴销（带摩擦）", "zh_desc": "一端是轴、一端是带摩擦销的连接件，把轴孔件固定到销孔件上（蓝色）。"},
    "11214.dat":  {"zh_name": "轴销 长 3L", "zh_desc": "加长的轴销连接件，3 孔长，带摩擦，跨距更大的固定连接。"},
    "6558.dat":   {"zh_name": "摩擦销 长 3L", "zh_desc": "3 孔长的带摩擦双头连接销（蓝色）。"},
    "32002.dat":  {"zh_name": "摩擦销 3/4", "zh_desc": "3/4 长的短摩擦销，用于薄件之间的紧固连接。"},
    "32062.dat":  {"zh_name": "轴 2L", "zh_desc": "2 孔长的科技轴，带定位槽口，传递旋转（红色）。"},
    "4519.dat":   {"zh_name": "轴 3L", "zh_desc": "3 孔长的科技轴，穿过轴孔传递旋转（深灰色）。"},
    "3705.dat":   {"zh_name": "轴 4L", "zh_desc": "4 孔长的科技轴，常用作齿轮 / 车轮的传动轴。"},
    "10089c01.dat": {"zh_name": "动力组大马达", "zh_desc": "Power Functions 大号电动马达总成，提供旋转动力输出。"},
    "10090.dat":  {"zh_name": "大马达外壳（前）", "zh_desc": "Power Functions 大马达外壳前盖部件。"},
    "39369.dat":  {"zh_name": "底板 11×19", "zh_desc": "11×19 大尺寸底板，作为整个装配的承载基座。"},
    "71709.dat":  {"zh_name": "大面板 3×7", "zh_desc": "3×7 科技面板，20 个端口、4 个插接聚合，常作车身外壳大覆盖件。"},
}

CATEGORY_ZH = {
    "Pin": "销", "Axle": "轴", "Connector": "连接器", "Beam": "梁",
    "Gear": "齿轮", "Wheel": "车轮", "Plate": "平板", "Tile": "平滑片",
    "Brick": "砖", "Panel": "面板", "Cylinder": "气缸", "Pneumatic": "气动件",
    "Steering": "转向件", "Electric": "电动件", "Sticker": "贴纸", "Other": "零件",
}

_SIZE_RE = re.compile(r"\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?", re.I)
_LEN_RE = re.compile(r"\b(\d+(?:\.\d+)?)l\b", re.I)


def _norm_size(name: str) -> str | None:
    """提取尺寸 token，如 '2 x  4' -> '2×4'，'5 x 0.5' -> '5×0.5'。"""
    m = _SIZE_RE.search(name)
    if not m:
        return None
    return re.sub(r"\s*x\s*", "×", m.group(0).strip(), flags=re.I)


def _len_token(name: str) -> str | None:
    """提取 LDraw 长度 'NL'（N 孔长），如 'Axle 3' 没 L 不算；'3L Pin' -> '3L'。"""
    m = _LEN_RE.search(name)
    return f"{m.group(1)}L" if m else None


def translate_desc(name: str) -> str:
    """整串术语表翻译，得到中文为主的完整描述串（保留尺寸 / 数字）。"""
    s = " " + name.lower() + " "
    # 符号预处理：'w/' 'with' 同义，'&' 'and' 同义，'_' 是 unofficial 前缀标记
    s = re.sub(r"\bw/\s*", " 带 ", s)
    s = s.replace("&", " 和 ").replace("_", " ")
    # 先把尺寸占位，避免被拆
    sizes: list[str] = []
    def _stash(m: re.Match) -> str:
        sizes.append(re.sub(r"\s*x\s*", "×", m.group(0).strip(), flags=re.I))
        return f" \0{len(sizes)-1}\0 "
    s = _SIZE_RE.sub(_stash, s)
    for en, zh in _ALL_TERMS:
        s = re.sub(r"\b" + re.escape(en) + r"\b", zh, s)
    # 还原尺寸
    for i, sz in enumerate(sizes):
        s = s.replace(f"\0{i}\0", sz)
    # 去掉前缀符号、压缩空格
    s = s.replace("~", "").replace("=", "")
    s = re.sub(r"\s+", " ", s).strip()
    # 去掉行首冗余的"科技"（几乎每条都有，去掉更像自然描述；category 仍可搜）
    if s.startswith("科技 "):
        s = s[3:]
    return s


def _pick_type(low: str) -> tuple[str, int]:
    """返回 (中文主类型词, 命中位置)；没命中返回 ('', -1)。"""
    for en, zh in TYPE_TERMS:
        idx = low.find(en)
        if idx != -1:
            return zh, idx
    return "", -1


def gen_name(part_id: str, en_name: str, category: str) -> tuple[str, str]:
    """规则生成 (zh_name, zh_desc)。"""
    low = en_name.lstrip("~=").lower()
    desc = translate_desc(en_name)

    type_zh, _ = _pick_type(low)
    if not type_zh:
        type_zh = CATEGORY_ZH.get(category, "零件")

    size = _norm_size(en_name)
    length = _len_token(en_name)

    # 从完整描述里挑显著修饰（至多 2 个），拼进主名。
    salient = [m for m in SALIENT_MODS if m in desc]
    # 稳定顺序：按 SALIENT_MODS 出现在 desc 的位置排序
    salient.sort(key=lambda m: desc.find(m))
    salient = salient[:2]

    parts = [type_zh]
    if size:
        parts.append(size)
    elif length:
        parts.append(length)
    if salient:
        parts.append("·" + "".join(salient))
    zh_name = " ".join(parts[:2]) + ("".join(parts[2:]) if len(parts) > 2 else "")
    # 收尾：主名控制长度
    zh_name = zh_name.strip()
    if len(zh_name) > 16:
        zh_name = zh_name[:16]
    return zh_name, desc


def main() -> None:
    cfg = json.load(open(DATA_FILE, encoding="utf-8"))
    out: dict[str, dict[str, str]] = {}
    n_override = 0
    for part_id in cfg:
        if part_id in OVERRIDES:
            out[part_id] = OVERRIDES[part_id]
            n_override += 1
            continue
        en = _get_part_name(part_id, LDRAW_PARTS_DIR)
        # category 兜底（避免循环依赖，简单内联判断）
        from backend.category import categorize
        cat = categorize(en)
        zh_name, zh_desc = gen_name(part_id, en, cat)
        out[part_id] = {"zh_name": zh_name, "zh_desc": zh_desc}

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"生成 {len(out)} 条中文名 -> {OUT_FILE}（其中 {n_override} 条人工 override）")


if __name__ == "__main__":
    main()

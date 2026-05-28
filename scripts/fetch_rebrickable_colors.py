#!/usr/bin/env python3
"""
fetch_rebrickable_colors.py
===========================
从 Rebrickable 公开数据算出「每个零件最常见的真实颜色」，产出
data/rebrickable_common_colors.json（件号 → LDraw 颜色码），供
gen_part_colors.py 作为真实色来源。

为什么用 Rebrickable：
  它按全部官方套装清单统计了每个零件各颜色的出现量。某零件「最常见颜色」
  = 跨所有套装累计数量最高的颜色，是「这个件你平时见到的颜色」的最佳代理。
  ⭐ 关键：Rebrickable 的 color id 直接采用 LDraw 颜色码（0=黑/71=浅蓝灰/
  4=红/14=黄/19=茶…），故 color_id 可直接当 LDraw 码用，无需再映射。

数据（公开、免登录 CDN）：
  parts.csv.gz / colors.csv.gz / inventory_parts.csv.gz
  缓存在 .rb_cache/（gitignore，不提交）；缺失时自动下载。

匹配：LDraw 件号 → Rebrickable part_num。LDraw 用相同设计号，故多数直接命中；
  变体（.dat / -fN 碎片 / cNN 总成 / pNN 图案 / 末尾字母模具变体）逐级剥到
  base 再匹配，取 base 的最常见色。

用法：python scripts/fetch_rebrickable_colors.py
  （一次性 / 偶尔刷新；产物已提交，日常 gen_part_colors.py 不需联网。）
"""
import csv
import gzip
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(REPO, ".rb_cache")
CONFIGS = os.path.join(REPO, "data", "ldraw_port_configs.json")
OUT = os.path.join(REPO, "data", "rebrickable_common_colors.json")
BASE_URL = "https://cdn.rebrickable.com/media/downloads/{}.csv.gz"
FILES = ["parts", "colors", "inventory_parts"]

# Rebrickable 里非「单色实体件」的颜色 id：不作为零件本体常见色。
# -1 [No Color/Any]，9999 [Unknown]；trans/电镀等仍保留（个别件确实是透明）。
SKIP_COLORS = {"-1", "9999"}


def ensure_cache() -> None:
    os.makedirs(CACHE, exist_ok=True)
    for name in FILES:
        path = os.path.join(CACHE, f"{name}.csv.gz")
        if os.path.exists(path):
            continue
        url = BASE_URL.format(name)
        print(f"downloading {url} ...")
        urllib.request.urlretrieve(url, path)


def open_csv(name: str):
    return csv.DictReader(gzip.open(os.path.join(CACHE, f"{name}.csv.gz"), "rt", encoding="utf-8"))


def norm(pid: str) -> str:
    pid = pid.lower()
    if pid.endswith(".dat"):
        pid = pid[:-4]
    return pid


def base_candidates(pid: str):
    """从 LDraw 件号派生候选 Rebrickable part_num（精确 → 逐级剥变体后缀）。"""
    p = norm(pid)
    cands = [p]
    # -fN 碎片
    m = re.sub(r"-f\d+$", "", p)
    if m != p:
        cands.append(m)
        p = m
    # cNN 总成 / pNN(p\d+/px\d+/pt\d+) 图案 / dNN 贴纸 / kNN / psN
    stripped = re.sub(r"(c\d+|p[a-z]?\d+|d\d+|k\d+|ps\d+)$", "", p)
    if stripped and stripped != p:
        cands.append(stripped)
        p = stripped
    # 末尾单字母模具变体（3648a / 32556b）
    if re.search(r"\d[a-z]$", p):
        cands.append(p[:-1])
    seen, out = set(), []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def main() -> None:
    ensure_cache()

    # 1) 每个 part_num 各颜色累计数量。
    print("aggregating inventory_parts ...")
    by_part = defaultdict(lambda: defaultdict(int))
    n = 0
    for row in open_csv("inventory_parts"):
        if row.get("is_spare") == "t":
            continue
        cid = row["color_id"]
        if cid in SKIP_COLORS:
            continue
        # 跳过非 LDraw 标准色（Rebrickable 的 Modulex/特殊色 id >= 1000），
        # 否则会赋上后端渲染不出的色码。
        if cid.lstrip("-").isdigit() and int(cid) >= 1000:
            continue
        try:
            q = int(row["quantity"] or 0)
        except ValueError:
            q = 0
        if q <= 0:
            continue
        by_part[row["part_num"].lower()][cid] += q
        n += 1
    print(f"  scanned {n} part-color rows; {len(by_part)} distinct part_num")

    def common_color(part_num: str):
        d = by_part.get(part_num)
        if not d:
            return None
        cid = max(d.items(), key=lambda kv: kv[1])[0]
        try:
            return int(cid)
        except ValueError:
            return None

    # 2) 匹配本仓零件全集。
    with open(CONFIGS, encoding="utf-8") as f:
        catalog = list(json.load(f).keys())

    result = {}
    matched = 0
    for pid in catalog:
        key = norm(pid)
        color = None
        for cand in base_candidates(pid):
            color = common_color(cand)
            if color is not None:
                break
        if color is not None:
            result[key] = color
            matched += 1

    result = dict(sorted(result.items()))
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(result, f, ensure_ascii=False, indent=0)
        f.write("\n")
    print(f"matched {matched}/{len(catalog)} catalog parts -> {OUT}")


if __name__ == "__main__":
    main()

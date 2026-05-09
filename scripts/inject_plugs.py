"""
inject_plugs.py
===============
一次性数据迁移：用 backend/plug_clustering.py 启发式给
data/ldraw_port_configs.json 的 2144 part 注入 plug 元数据。

Schema 改动（纯增量、向后兼容）：
  - 顶层每 part 加 'plug_version': 'v1' 标记迁移过
  - 每 part 加 'plugs': List[Plug.to_dict()] —— plug 反向索引
  - 每 site 加 'plug_ids': List[str] —— site 涉及的 plug（同 site 多 port
    分属不同 plug 时含多个，e.g. 2780 销 site 含 ±x 两个 plug）
  - 每 port 加 'plug_id': str —— port 直接归属的 plug

不删/改任何已有字段。`status / verified / version` 不动。

跑法（项目根目录）：
    python scripts/inject_plugs.py [--dry-run] [--limit N]

dry-run 不写盘，仅打印变更摘要。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.plug_clustering import compute_plugs  # noqa: E402

DATA_PATH = ROOT / "data" / "ldraw_port_configs.json"
PLUG_VERSION = "v1"


def inject_one(part_id: str, cfg: dict) -> dict:
    """给单 part 的 cfg 注入 plug 字段。返回新 cfg（未修改原 dict）。"""
    sites = cfg.get("sites", [])
    plugs = compute_plugs(sites, part_id)

    # 反向索引：(site_id, port_idx) -> plug_id
    member_to_plug: dict = {}
    for p in plugs:
        for member in p.members:
            member_to_plug[tuple(member)] = p.plug_id

    new_cfg = dict(cfg)
    new_cfg["plug_version"] = PLUG_VERSION
    new_cfg["plugs"] = [p.to_dict() for p in plugs]

    # site / port 注入 plug_id
    new_sites = []
    for site in sites:
        new_site = dict(site)
        plug_ids_for_site = set()
        new_ports = []
        for idx, port in enumerate(site.get("ports", [])):
            plug_id = member_to_plug.get((site["id"], idx))
            new_port = dict(port)
            if plug_id is not None:
                new_port["plug_id"] = plug_id
                plug_ids_for_site.add(plug_id)
            new_ports.append(new_port)
        new_site["ports"] = new_ports
        # site 涉及的所有 plug_ids（同 site 跨多 plug 时含多个）
        new_site["plug_ids"] = sorted(plug_ids_for_site)
        new_sites.append(new_site)
    new_cfg["sites"] = new_sites
    return new_cfg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="不写盘，仅打印摘要")
    parser.add_argument("--limit", type=int, default=None, help="仅跑前 N 个 part（调试用）")
    args = parser.parse_args()

    print(f"[inject_plugs] 加载 {DATA_PATH}...")
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    keys = sorted(data.keys())
    if args.limit:
        keys = keys[: args.limit]
        print(f"[inject_plugs] --limit {args.limit}")

    new_data: dict = {}
    plug_count_dist: dict = {}
    parts_with_plugs = 0

    for pid in keys:
        cfg = data[pid]
        new_cfg = inject_one(pid, cfg)
        new_data[pid] = new_cfg
        n_plugs = len(new_cfg["plugs"])
        plug_count_dist[n_plugs] = plug_count_dist.get(n_plugs, 0) + 1
        if n_plugs > 0:
            parts_with_plugs += 1

    # 不在 limit 模式时把未处理的 part 原样保留
    if args.limit:
        for pid in data:
            if pid not in new_data:
                new_data[pid] = data[pid]

    print(f"\n[inject_plugs] {len(keys)} part 处理完成")
    print(f"  含 plug 的 part: {parts_with_plugs}")
    print("  plug 数分布:")
    for k in sorted(plug_count_dist.keys()):
        print(f"    {k:3d} plug: {plug_count_dist[k]:5d} part")

    if args.dry_run:
        print("\n[inject_plugs] --dry-run，不写盘")
        return

    # 落盘 — 用 indent=2 保持可读性（原文件就是 indent=2）
    print(f"\n[inject_plugs] 写入 {DATA_PATH}...")
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(new_data, f, ensure_ascii=False, indent=2)
    print("[inject_plugs] done")


if __name__ == "__main__":
    main()

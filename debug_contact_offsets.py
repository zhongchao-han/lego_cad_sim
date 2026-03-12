import numpy as np

from ldraw_parser import LDrawParser, LDU_TO_SI


def print_ports(part_id: str, ldraw_root: str = "ldraw_lib") -> None:
    parser = LDrawParser(ldraw_path=ldraw_root)
    dat_name = part_id if part_id.lower().endswith(".dat") else f"{part_id}.dat"
    ports = parser.parse_dat_file(dat_name)

    print(f"\n=== Part {part_id} ({dat_name}) ===")
    if not ports:
        print("  no semantic ports parsed")
        return

    for idx, p in enumerate(ports):
        d = p.to_dict()
        pos = np.array(d["position"])
        rot = np.array(d["rotation"])
        axis_local = np.array([0.0, 1.0, 0.0])
        axis_world = rot @ axis_local
        print(
            f"  [{idx}] type={d['type']}, "
            f"pos(m)={pos}, "
            f"axis_world={axis_world}"
        )


if __name__ == "__main__":
    # 针对当前常用的科技件，打印其端口统计信息，方便人工决定接触偏移量
    for pid in ["32524", "32523", "6558"]:
        print_ports(pid)


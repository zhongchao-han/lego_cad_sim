import os
import json
import logging
import shutil

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

DATA_PATH = "data/ldraw_port_configs.json"

def apply_rx180_to_rotation(rot_list):
    """
    对一个 3x3 旋转矩阵（嵌套列表形式）右乘 Rx(180)
    等价于对矩阵的第二列（Y）和第三列（Z）分别取反。
    """
    new_rot = []
    for row in rot_list:
        if len(row) == 3:
            # col 0 不变，col 1 和 col 2 取反
            new_row = [
                float(row[0]),
                float(-row[1]),
                float(-row[2])
            ]
            new_rot.append(new_row)
        else:
            new_rot.append(row)
    return new_rot

def patch_db():
    if not os.path.exists(DATA_PATH):
        logger.error(f"找不到配置数据库: {DATA_PATH}")
        return

    # 备份
    backup_path = DATA_PATH + ".z_axis_patch.bak"
    shutil.copy2(DATA_PATH, backup_path)
    logger.info(f"已备份数据库至: {backup_path}")

    with open(DATA_PATH, "r", encoding="utf-8") as f:
        db = json.load(f)

    patch_count = 0
    for part_id, data in db.items():
        # 补丁裸端口 (raw_ports)
        if "ports" in data and isinstance(data["ports"], list):
            for port in data["ports"]:
                if "rotation" in port:
                    port["rotation"] = apply_rx180_to_rotation(port["rotation"])
                    patch_count += 1

        # 补丁聚合站点中的极化端口 (sites -> ports)
        if "sites" in data and isinstance(data["sites"], list):
            for site in data["sites"]:
                if "ports" in site and isinstance(site["ports"], list):
                    for port in site["ports"]:
                        if "rotation" in port:
                            port["rotation"] = apply_rx180_to_rotation(port["rotation"])
                            patch_count += 1

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

    logger.info(f"修复完成！共升级了 {len(db)} 个零件，翻转了 {patch_count} 个空间端口的 Z/Y 轴。Verified 状态全部安全保留。")

if __name__ == "__main__":
    patch_db()

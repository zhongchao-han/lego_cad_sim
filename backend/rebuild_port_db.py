import os
import glob
import json
import logging
import sys
from concurrent.futures import ProcessPoolExecutor
from backend.geometry_processor import GeometryProcessor

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def process_single_part(part_name: str, ldraw_dir: str):
    try:
        gp = GeometryProcessor(ldraw_dir)
        ports = gp.discover_ports(part_name)
        return part_name, {
            "status": "verified",
            "confidence": 1.0,
            "ports": ports
        }
    except Exception as e:
        logger.error(f"Error processing {part_name}: {e}")
        return part_name, None

def rebuild_all(ldraw_dir: str, config_path: str):
    parts_folder = os.path.join(ldraw_dir, "parts")
    dat_files = glob.glob(os.path.join(parts_folder, "*.dat"))
    
    total = len(dat_files)
    logger.info(f"Starting port discovery for {total} parts...")

    db = {}
    
    for i, f in enumerate(dat_files):
        part_name = os.path.basename(f).lower()
        _, conf = process_single_part(part_name, ldraw_dir)
        if conf:
            db[part_name] = conf
        if (i+1) % 100 == 0 or (i+1) == total:
            logger.info(f"Progress: {i+1}/{total} ({(i+1)/total*100:.1f}%)")

    # Load existing to preserve any metadata if necessary, but here we enforce the rewrite of ports
    existing = {}
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            try:
                existing = json.load(f)
            except Exception:
                pass
                
    # Merge strategy: Overwrite ports and make verified, keep everything else
    for p, conf in db.items():
        if p not in existing:
            existing[p] = conf
        else:
            existing[p]["ports"] = conf["ports"]
            existing[p]["status"] = "verified"
            existing[p]["confidence"] = 1.0

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=2)
        
    logger.info(f"Successfully rebuilt port configurations and saved to {config_path}")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python rebuild_port_db.py <LDraw_Dir> <Output_JSON>")
        sys.exit(1)
        
    rebuild_all(sys.argv[1], sys.argv[2])

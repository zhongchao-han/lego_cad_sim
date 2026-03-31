"""
Targeted update script for 64179 port configuration.
"""
import sys
import os
import json
import logging

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.geometry_processor import GeometryProcessor
from backend.site_utils import cluster_ports_into_sites, sites_to_response

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

LDRAW_ROOT = "ldraw_lib"
DATA_PATH = "data/ldraw_port_configs.json"
PART_ID = "parts/64179.dat"

def update_64179():
    logger.info(f"Targeted update for {PART_ID}")
    
    geo_proc = GeometryProcessor(ldraw_path=LDRAW_ROOT)
    
    # 1. Discover the ports using the patched heuristic
    raw_ports = geo_proc.discover_ports("64179.dat")
    logger.info(f"Discovered {len(raw_ports)} raw ports via GeometryProcessor.")
    
    # 2. Cluster them into semantic Sites
    try:
        computed_sites = cluster_ports_into_sites(raw_ports, PART_ID)
        sites_resp = sites_to_response(computed_sites)
        logger.info(f"Clustered into {len(sites_resp)} sites.")
    except Exception as exc:
        logger.error(f"Clustering failed: {exc}")
        return
        
    # 3. Read current DB
    if not os.path.exists(DATA_PATH):
        logger.error(f"DB not found at {DATA_PATH}")
        return
        
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        db = json.load(f)
        
    # backup DB
    backup_path = DATA_PATH + ".bak_64179"
    with open(backup_path, "w", encoding="utf-8") as bf:
        json.dump(db, bf, ensure_ascii=False)
        
    # 4. Update the DB entry
    db[PART_ID] = {
        "status": "pending",
        "confidence": 0.8,
        "ports": raw_ports,
        "sites": sites_resp,
    }
    
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
        
    logger.info(f"Successfully updated {PART_ID} in {DATA_PATH}.")

if __name__ == "__main__":
    update_64179()

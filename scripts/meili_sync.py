import os
import json
import logging
import re
import meilisearch
from typing import Dict, Any, List

# Rule 6: Validate logging explicitly
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

MEILI_HOST: str = os.getenv("MEILI_HOST", "http://localhost:7700")
MEILI_MASTER_KEY: str = os.getenv("MEILI_MASTER_KEY", "Lego_CAD_Sim_Meili_Master_Key_2026")
DATA_FILE: str = os.path.join(os.path.dirname(__file__), "..", "data", "ldraw_port_configs.json")
LDRAW_PARTS_DIR: str = os.path.join(os.path.dirname(__file__), "..", "ldraw_lib", "parts")

def extract_part_name(part_id: str) -> str:
    """
    Extract the human-readable description from the first line of the LDraw .dat file.
    Example: '0 ~Part 3001 Brick 2 x 4' -> 'Brick 2 x 4'
    """
    filepath = os.path.join(LDRAW_PARTS_DIR, part_id)
    if not os.path.exists(filepath):
        logger.debug(f"[Name Extraction] File not found for: {part_id}")
        return f"Unknown {part_id}"
        
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            first_line = f.readline().strip()
            
            # LDraw Line 0 standard:
            # 0 <description> OR 0 ~Part 32269 description
            logger.debug(f"[Name Extraction] Raw line 0 for {part_id}: {first_line}")
            if first_line.startswith("0 "):
                name = first_line[2:].strip()
                # Clean prefix like ~Part 1234 or ~Moved or just 3001
                # Often it is just "Brick 2 x 4", but if starting with a tilde we should strip it
                if name.startswith("~"):
                    # split on space and drop first token
                    tokens = name.split(maxsplit=2)
                    if len(tokens) >= 3 and tokens[1].isdigit():
                        name = tokens[2]
                    elif len(tokens) >= 2:
                        name = name.split(maxsplit=1)[1]
                return name
    except Exception as e:
        logger.error(f"[Name Extraction] Failed to read part {part_id}: {e}")
        
    return f"Unknown {part_id}"

def main() -> None:
    logger.info("Initializing Meilisearch client...")
    try:
        client = meilisearch.Client(MEILI_HOST, MEILI_MASTER_KEY)
        client.health()
    except Exception as e:
        logger.error(f"Cannot connect to MeiliSearch at {MEILI_HOST}: {e}")
        logger.info("Tip: Start it using 'docker-compose up -d'")
        return

    logger.debug(f"Reading lego part configs from {DATA_FILE}...")
    if not os.path.exists(DATA_FILE):
        logger.error(f"Config file not found: {DATA_FILE}")
        return

    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        data: Dict[str, Any] = json.load(f)

    documents: List[Dict[str, Any]] = []
    logger.info(f"Processing {len(data)} parts for sync...")

    for part_id, config in data.items():
        # strict typing and defensive programming
        if not isinstance(config, dict):
            continue
            
        part_num = part_id.lower().replace(".dat", "")
        # MeiliSearch Document IDs must match ^[a-zA-Z0-9-_]+$
        doc_id = part_num.replace(" ", "_").replace(".", "_")
        
        name = extract_part_name(part_id)
        
        doc = {
            "id": doc_id,
            "part_num": part_num,
            "name": name,
            "status": str(config.get("status", "pending")),
            "confidence": float(config.get("confidence", 1.0)),
            # Use specific image if already cached, else format standard fallback URL
            "thumbnail_url": config.get("mesh_url", f"/ldraw_meshes/{part_num}_c7.glb")
        }
        documents.append(doc)

    logger.info("Pushing to Meilisearch index 'parts'")
    try:
        index = client.index("parts")
        
        settings = {
            "searchableAttributes": ["part_num", "name"],
            "filterableAttributes": ["status"],
            "sortableAttributes": ["confidence"],
            "typoTolerance": {
                "disableOnAttributes": ["part_num"], # NO typo tolerance for part number
                "minWordSizeForTypos": {
                    "oneTypo": 4,
                    "twoTypos": 8
                }
            }
        }
        logger.debug("Updating index settings...")
        task = index.update_settings(settings)
        logger.info(f"Settings update task enqueued: {task.task_uid}")

        logger.debug(f"Submitting {len(documents)} documents...")
        add_task = index.add_documents(documents)
        logger.info(f"Documents addition task enqueued: {add_task.task_uid}")
        
    except Exception as e:
        logger.error(f"Failed to push documents to MeiliSearch: {e}")
        return

    logger.info("Waiting for Indexation tasks...")
    try:
        # Wait up to ~1min for completion
        client.wait_for_task(add_task.task_uid, timeout_in_ms=60000)
        logger.info("Sync completed successfully.")
    except Exception as e:
        logger.warning(f"Timeout waiting for indexing to complete, it may still run in the background: {e}")

if __name__ == "__main__":
    main()

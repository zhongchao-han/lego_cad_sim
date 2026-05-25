import os
import json
import logging
import meilisearch
from typing import Dict, Any

from backend.category import categorize, get_part_name as _get_part_name

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

MEILI_HOST = os.getenv("MEILI_HOST", "http://localhost:7700")
MEILI_MASTER_KEY = os.getenv("MEILI_MASTER_KEY", "Lego_CAD_Sim_Meili_Master_Key_2026")
# 配置文件默认路径
DATA_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "ldraw_port_configs.json")
# 中文名 / 描述映射（由 backend/gen_zh_names.py 生成）。缺失则中文字段留空，不阻断同步。
ZH_NAMES_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "part_names_zh.json")
# LDraw 零件库默认路径。
# 约定：LDRAW_PARTS_ROOT 是**库根目录**（含 parts/、p/ 等子目录），跟
# backend/server.py 同源。.dat 实际放在 root/parts/，所以这里手动 join。
# 旧实现误把 env 当 parts/ 子目录用，导致 get_part_name 文件找不到 →
# 全部 fallback 到 "170.dat" 这种 filename，Meili 索引名字段失效，
# 用户搜 "plate"/"2x4"/"brick" 全部 0 hit。
_LDRAW_LIB_ROOT = os.environ.get(
    "LDRAW_PARTS_ROOT",
    os.path.join(os.path.dirname(__file__), "..", "ldraw_lib"),
)
LDRAW_PARTS_DIR = os.path.join(_LDRAW_LIB_ROOT, "parts")


def get_part_name(part_id: str) -> str:
    """轻量包装 backend.category.get_part_name，沿用本模块的 LDRAW_PARTS_DIR。"""
    return _get_part_name(part_id, LDRAW_PARTS_DIR)

def sync_to_meilisearch() -> None:
    logger.debug("[DEBUG] sync_to_meilisearch() 调用: 开始执行数据同步...")
    if not os.path.exists(DATA_FILE):
        logger.error(f"配置文件未找到: {DATA_FILE}")
        logger.debug(f"[DEBUG] sync_to_meilisearch() 退出: 找不到数据文件 {DATA_FILE}")
        return

    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            config_data: Dict[str, Any] = json.load(f)
    except Exception as e:
        logger.error(f"加载 JSON 配置文件失败: {e}")
        return

    # 中文名映射（可选）：缺文件不致命，仅记一条 warning。
    zh_map: Dict[str, Any] = {}
    if os.path.exists(ZH_NAMES_FILE):
        try:
            with open(ZH_NAMES_FILE, 'r', encoding='utf-8') as f:
                zh_map = json.load(f)
        except Exception as e:
            logger.warning(f"加载中文名映射失败（将跳过中文字段）: {e}")
    else:
        logger.warning(f"未找到中文名映射 {ZH_NAMES_FILE}，请先跑 python -m backend.gen_zh_names")

    try:
        client = meilisearch.Client(MEILI_HOST, MEILI_MASTER_KEY)
        
        index_uid = 'parts'
        index = client.index(index_uid)
        
        documents = []
        for part_id, metadata in config_data.items():
            # meilisearch requires document ID to be alphanumeric + '-' or '_'
            doc_id = part_id.lower().replace('.dat', '').replace('-', '_').replace(' ', '_').replace('/', '_')
            part_num = part_id.lower().replace('.dat', '')
            name = get_part_name(part_id)
            zh = zh_map.get(part_id, {})

            doc = {
                'id': doc_id,
                'part_num': part_num,
                'name': name,
                'zh_name': zh.get('zh_name', ''),   # 中文名（可搜、列表显示）
                'zh_desc': zh.get('zh_desc', ''),   # 中文描述（可搜、tooltip）
                'category': categorize(name),  # L50：分级目录字段
                'status': metadata.get('status', 'pending'),
                'confidence': metadata.get('confidence', 1.0),
                'thumbnail_url': f"/api/thumbnails/{part_num}.png",
                'has_sites': "sites" in metadata
            }
            documents.append(doc)

        if documents:
            logger.info(f"正在向 MeiliSearch 同步 {len(documents)} 个零件文档...")
            print("正在配置索引...")
            client.index('parts').update_settings({
                'searchableAttributes': ['part_num', 'zh_name', 'name', 'zh_desc', 'category'],
                'filterableAttributes': ['status', 'confidence', 'has_sites', 'category'],
                'synonyms': {
                    'plate': ['baseplate', 'panel', 'board', 'slab', 'tile'],
                    'baseplate': ['plate', 'panel', 'board'],
                    'panel': ['plate', 'baseplate', 'board', 'fairing'],
                    'beam': ['liftarm', 'frame', 'arm'],
                    'liftarm': ['beam', 'frame', 'arm'],
                    'hole': ['holes', 'technic', 'perforated'],
                    'holes': ['hole', 'technic', 'perforated'],
                    'technic': ['hole', 'holes'],
                    'large': ['macro', 'big', 'giant'],
                    'brick': ['block'],
                    'pin': ['peg', 'connector']
                }
            })
            index.add_documents(documents)
            
            logger.info("文档同步任务已全部提交！")
            logger.debug("[DEBUG] sync_to_meilisearch() 分支: 提交完毕")
        else:
            logger.warning("没有需要同步的文档。")
            logger.debug("[DEBUG] sync_to_meilisearch() 分支: 文档为空，跳过提交")
            
    except Exception as e:
        logger.error(f"同步至 MeiliSearch 时发生错误: {e}")
        logger.debug(f"[DEBUG] sync_to_meilisearch() 异常: {e}")

if __name__ == "__main__":
    sync_to_meilisearch()

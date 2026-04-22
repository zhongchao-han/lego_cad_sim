import os
import glob
import shutil
import logging
from fastapi import APIRouter, UploadFile, File, Form

router = APIRouter()
logger = logging.getLogger(__name__)

# 隔离的工具侧路径定义
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LDRAW_PARTS_ROOT = os.path.join(PROJECT_ROOT, "ldraw_lib")
THUMBNAIL_CACHE_ROOT = os.path.join(PROJECT_ROOT, "data", "custom_assets", "thumbnails")


@router.get("/api/all_parts")
async def get_all_parts(missing_only: bool = False) -> list[str]:
    """获取本地全量零件清单，支持仅查漏差集模式用于离线生成器."""
    parts_dir = os.path.join(LDRAW_PARTS_ROOT, "parts")
    if not os.path.exists(parts_dir):
        return []

    dat_files = glob.glob(os.path.join(parts_dir, "*.dat"))

    if missing_only:
        # 基于本地文件系统构建已渲染缓存库的查询哈希集
        existing_pngs = {
            os.path.basename(f).lower().replace(".png", ".dat")
            for f in glob.glob(os.path.join(THUMBNAIL_CACHE_ROOT, "*.png"))
        }
        return [
            os.path.basename(f)
            for f in dat_files
            if os.path.basename(f).lower() not in existing_pngs
        ]

    return [os.path.basename(f) for f in dat_files]


@router.post("/api/tools/upload_thumbnail")
async def upload_thumbnail(part_id: str = Form(...), file: UploadFile = File(...)):
    """接收前端离线渲染器生成的原生二进制图片。自带原子替换隔离。"""
    base_name = part_id.lower().replace(".dat", "")
    target_file = os.path.join(THUMBNAIL_CACHE_ROOT, f"{base_name}.png")
    backup_file = target_file + ".bak"

    if os.path.exists(target_file):
        shutil.move(target_file, backup_file)

    try:
        with open(target_file, "wb") as f:
            shutil.copyfileobj(file.file, f)

        if os.path.exists(backup_file):
            os.remove(backup_file)

        return {"status": "success", "msg": f"Oven baked {base_name}.png"}
    except Exception as e:
        logger.error(f"Failed to upload thumbnail {part_id}: {e}")
        if os.path.exists(backup_file):
            shutil.move(backup_file, target_file)
        return {"status": "error", "msg": str(e)}

# scripts/fetch_thumbnails.py
import json
import os
import glob
import time
import urllib.request
import urllib.error
import logging
from typing import Set, List
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor

try:
    from PIL import Image
    import io
except ImportError as e:
    raise ImportError("请确保已安装 Pillow 库: pip install Pillow") from e

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 配置路径
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
LDRAW_PARTS_DIR = os.path.join(PROJECT_ROOT, 'ldraw_lib', 'parts')
THUMBNAIL_DIR = os.path.join(DATA_DIR, 'custom_assets', 'thumbnails')

# Rebrickable LDraw CDN 基础 URL
CDN_BASE_URL = "https://cdn.rebrickable.com/media/parts/ldraw/7"

def ensure_dirs():
    os.makedirs(THUMBNAIL_DIR, exist_ok=True)

def get_all_ldraw_parts() -> List[str]:
    """从本地 ldraw_lib/parts 目录动态扫描所有的 .dat 零件号"""
    if not os.path.exists(LDRAW_PARTS_DIR):
        logger.error(f"LDraw 零件目录不存在: {LDRAW_PARTS_DIR}")
        return []
    
    dat_files = glob.glob(os.path.join(LDRAW_PARTS_DIR, '*.dat'))
    part_ids = [os.path.basename(f).lower().replace(".dat", "") for f in dat_files]
    return part_ids

def download_and_resize_thumbnail(base_name: str) -> str:
    """下载缩略图并将其尺寸缩小一倍 (50%)"""
    target_file = os.path.join(THUMBNAIL_DIR, f"{base_name}.png")
    
    if os.path.exists(target_file):
        return f"[SKIPPED] {base_name} 缩略图已存在"
    
    url = f"{CDN_BASE_URL}/{base_name}.png"
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                img_data = resp.read()
                
                # --- 尺寸瘦身处理 ---
                try:
                    with Image.open(io.BytesIO(img_data)) as img:
                        # 缩小一倍 (50% 缩放)
                        new_size = (max(1, img.width // 2), max(1, img.height // 2))
                        # 使用 LANCZOS 保证缩小质量
                        resized_img = img.resize(new_size, Image.Resampling.LANCZOS)
                        resized_img.save(target_file, format="PNG", optimize=True)
                    return f"[SUCCESS] 烘焙完成 ({new_size[0]}x{new_size[1]}): {base_name}"
                except Exception as img_err:
                    return f"[ERROR] 图像处理失败 {base_name}: {img_err}"
            else:
                return f"[FAIL] HTTP 状态码异常 {resp.status} - {base_name}"
    except urllib.error.HTTPError as e:
        if e.code == 404:
             return f"[404] 官方库未收录出图 - {base_name}"
        return f"[FAIL] HTTP 错误: {e.code} - {base_name}"
    except Exception as e:
        return f"[ERROR] 网络/下载异常 {base_name}: {e}"

def main():
    ensure_dirs()
    # 全量下发取代之前的局域 JSON
    parts = get_all_ldraw_parts()
    
    logger.info(f"🚀 系统探测到 {len(parts)} 个原生零件，启动全量并行同步引擎[50% 尺寸压缩]...")
    
    # 使用线程池加速 2000 个零件的请求，max_workers 适中以避免被 CDN 封禁
    MAX_CONCURRENT_WORKERS = 15
    success_count = 0
    fail_count = 0
    skip_count = 0
    
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_WORKERS) as executor:
        future_to_pid = {executor.submit(download_and_resize_thumbnail, pid): pid for pid in parts}
        
        for idx, future in enumerate(concurrent.futures.as_completed(future_to_pid)):
            pid = future_to_pid[future]
            try:
                res_msg = future.result()
                if "[SUCCESS]" in res_msg:
                    success_count += 1
                elif "[SKIPPED]" in res_msg:
                    skip_count += 1
                else:
                    fail_count += 1
                    
                if (idx + 1) % 50 == 0 or idx == len(parts) - 1:
                    logger.info(f"进度: {idx + 1}/{len(parts)} | 成功: {success_count} | 跳过: {skip_count} | 无图: {fail_count} - 当前日志：{res_msg}")
            except Exception as e:
                logger.error(f"{pid} 执行发生毁灭性抛错: {e}")
                
    logger.info(f"✅ 全量同步任务彻底完成！[新增: {success_count}, 略过已存: {skip_count}, 无官方图集(404): {fail_count}]")

if __name__ == "__main__":
    main()

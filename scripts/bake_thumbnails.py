"""
scripts/bake_thumbnails.py — 无人值守 LDraw 缩略图烘焙
=========================================================

把 frontend/src/ThumbnailGenerator.tsx 里需要人手点 "Start" 的批量渲染流程
完全自动化：headless Chromium 打开 /generator → 自动点击 → 轮询完成。

依赖：
    pip install playwright
    playwright install chromium

前置：
    本地必须先 ./start_dev.ps1，确保后端 (8000) 与 Vite (5173) 已就绪。
    或自行起 dev server 后传 --url 覆盖默认地址。

用法：
    python scripts/bake_thumbnails.py                     # 仅补漏（默认）
    python scripts/bake_thumbnails.py --all               # 强制全量重烘
    python scripts/bake_thumbnails.py --headed            # 显示浏览器窗口排错
    python scripts/bake_thumbnails.py --url http://...    # 自定义入口

退出码：
    0  正常完成
    2  无法连接 dev server / 找不到 Start 按钮
    3  超过 --total-timeout
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit(
        "缺少 Playwright：\n"
        "    pip install playwright\n"
        "    playwright install chromium"
    )

DEFAULT_URL = "http://localhost:5173/generator"

# 在 ThumbnailGenerator 完成回调里追加的标志日志，作为最终完成信号
DONE_MARKER = "ALL PARTS RENDERED"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Headless LDraw thumbnail baker (drives ThumbnailGenerator UI)."
    )
    p.add_argument("--url", default=DEFAULT_URL, help=f"ThumbnailGenerator route (default: {DEFAULT_URL})")
    p.add_argument("--all", action="store_true", help="重烘所有 part（默认仅缺图）")
    p.add_argument("--headed", action="store_true", help="显示 Chromium 窗口，便于排错")
    p.add_argument(
        "--total-timeout",
        type=float,
        default=3 * 3600,
        help="总体超时上限（秒），默认 3 小时",
    )
    p.add_argument(
        "--poll-interval",
        type=float,
        default=0.5,
        help="进度轮询间隔（秒）",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=not args.headed,
            args=[
                # 在没有真实 GPU 的远程开发机/CI 上确保 WebGL 软渲染可用
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
            ],
        )
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        page.on("pageerror", lambda exc: logger.warning("[BROWSER ERR] %s", exc))

        try:
            return _run(page, args)
        finally:
            browser.close()


def _run(page, args: argparse.Namespace) -> int:
    logger.info("打开 %s", args.url)
    try:
        page.goto(args.url, wait_until="networkidle", timeout=30000)
    except PlaywrightTimeout:
        logger.error("无法连接 dev server — 是否已启动 ./start_dev.ps1？")
        return 2

    # 1. 翻转 'Skip Existing Images' 复选框以匹配 --all
    skip_box = page.locator("input[type=checkbox]").first
    skip_box.wait_for(state="visible", timeout=10000)
    desired_checked = not args.all
    if skip_box.is_checked() != desired_checked:
        # set_checked 会触发 React onChange，进而重发 /api/all_parts 请求；
        # 在 networkidle 之前继续读队列数会读到旧值，故等一次空闲。
        with page.expect_response(lambda r: "/api/all_parts" in r.url, timeout=15000):
            skip_box.set_checked(desired_checked)
        logger.info("Skip Existing Images = %s", desired_checked)

    # 2. 等待 Start 按钮可点击（队列拉取完成后才解禁）
    try:
        page.wait_for_function(
            """() => {
                const btn = [...document.querySelectorAll('button')]
                    .find(b => /Start GPU Batch Engine/.test(b.textContent || ''));
                return btn && !btn.disabled;
            }""",
            timeout=30000,
        )
    except PlaywrightTimeout:
        logger.error("Start 按钮始终不可点击 — /api/all_parts 是否返回？")
        return 2

    # 3. 读出队列规模
    queued = page.evaluate(
        """() => {
            const m = (document.body.innerText || '').match(/Found (\\d+) geometries/);
            return m ? +m[1] : -1;
        }"""
    )
    logger.info("队列规模：%d", queued)
    if queued == 0:
        logger.info("无缺失图，直接退出")
        return 0

    # 4. 点 Start
    logger.info("启动批量渲染")
    page.locator("button:has-text('Start GPU Batch Engine')").first.click()

    # 5. 轮询：进度报告 + 终止条件
    started = time.time()
    last_idx = -1

    while True:
        elapsed = time.time() - started
        if elapsed > args.total_timeout:
            logger.error("总超时 %.0fs，强行中断", elapsed)
            return 3

        state = page.evaluate(
            """(doneMarker) => {
                const btn = [...document.querySelectorAll('button')]
                    .find(b => /Start GPU|Rendering/.test(b.textContent || ''));
                let progress = null;
                if (btn) {
                    const m = (btn.textContent || '').match(/Rendering\\.\\.\\.\\s*\\((\\d+)\\/(\\d+)\\)/);
                    if (m) progress = { idx: +m[1], total: +m[2] };
                }
                const done = (document.body.innerText || '').includes(doneMarker);
                return { progress, done };
            }""",
            DONE_MARKER,
        )

        if state["progress"]:
            idx = state["progress"]["idx"]
            if idx != last_idx:
                last_idx = idx
                logger.info("进度 %d/%d", idx, state["progress"]["total"])

        if state["done"]:
            logger.info("渲染完成（耗时 %.1fs）", elapsed)
            break

        time.sleep(args.poll_interval)

    # 6. 摘取错误日志便于诊断
    errors = page.locator("div.text-red-400").all_text_contents()
    if errors:
        logger.warning("捕获 %d 条错误日志：", len(errors))
        for line in errors[:30]:
            logger.warning("   %s", line.strip())

    # 7. 简单成功率统计
    success_count = page.locator("div.text-green-400").count()
    logger.info("成功 %d / 失败 %d", success_count, len(errors))
    return 0 if not errors else 0  # 失败不阻断退出码（CDN 没有的 part 烘焙仍算正常）


if __name__ == "__main__":
    sys.exit(main())

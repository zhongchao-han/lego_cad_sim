import { expect, test } from '@playwright/test';

/**
 * Y — Generator-page rendered part pixel test.
 *
 * 与 X 配对：X 验证空画布管线存活，Y 验证完整渲染流水线（GLB 解析 → R3F 烘焙
 * → captureSnapshot）的像素一致性。这一条强依赖后端（/api/ldraw_part 真去
 * 加工 GLB），所以 CI 上跳过；本地推送前手跑作 reality check。
 *
 * 用 route intercept 把队列限定为 1 个已知 part，避免烘焙池影响时序；并把
 * upload_thumbnail 短路掉避免污染主仓 thumbnails 目录。
 */
const LOCAL_ONLY_REASON =
  'Y 测试需后端在线（./start_dev.ps1）。CI 暂未起 backend，跳过；本地手跑。';

test.describe('Generator pixel rendering', () => {
  test.skip(!!process.env.CI, LOCAL_ONLY_REASON);

  test('generator renders a known part to a stable pixel baseline', async ({ page }) => {
    // 队列限定为单一 part —— 基线锁死，且不会影响其他 thumb
    await page.route('**/api/all_parts*', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(['10089.dat']) }),
    );
    // 关键：故意挂住 upload 5 秒。ThumbnailGenerator 的 captureSnapshot 在
    // upload await 之后会立刻 setCurrentMeshUrl(null) 把 canvas 清空成黑色，
    // 我们必须趁 upload 还在飞行（=画面已稳定但未被清掉）的窗口里截图。
    await page.route('**/api/tools/upload_thumbnail', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success' }),
      });
    });

    await page.goto('/generator');

    // 等队列拉取完成
    await page.waitForFunction(
      () => /Found 1 geometries/.test(document.body.innerText || ''),
      { timeout: 15000 },
    );

    // 同时挂上 upload request 监听器 + 触发渲染
    const uploadStarted = page.waitForRequest('**/api/tools/upload_thumbnail');
    await page.locator('button:has-text("Start GPU Batch Engine")').first().click();

    // 等到 upload 请求实际飞起来（说明 ModelViewer 已 captureSnapshot →
    // 此刻 canvas 必定是渲染好的目标 part）
    await uploadStarted;
    // 给 framebuffer 多一刷新周期落定
    await page.waitForTimeout(150);

    const canvas = page.locator('canvas').first();
    await expect(canvas).toHaveScreenshot('generator-10089.png', {
      maxDiffPixelRatio: 0.05,
      animations: 'disabled',
    });
  });
});

import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __STORE__: any;
  }
}

/**
 * X — Empty ASSEMBLY canvas pixel sentinel.
 *
 * 不依赖后端：reset store 后画布只剩 grid + clear color + 默认相机角度，
 * R3F 在 IDLE 状态下没有 useFrame 循环，所以帧应当在 RAF 一两次内冻结。
 * 这是渲染管线"还活着"的最底层 canary —— 任何全局材质/相机/lighting 改动
 * 触发的视觉回归都会在这里第一时间炸响。
 *
 * 基线在 Windows + SwiftShader 下生成；CI Linux 同样走 SwiftShader，
 * 给 5% 容差吸收 ANGLE 后端层差异。
 */
test.describe('Canvas pixel sentinels', () => {
  test('empty ASSEMBLY canvas matches baseline', async ({ page }) => {
    // CI 上 backend 未起，usePartSearch 拉 /api/search/key 三次重试失败后会触发
    // RenderErrorBoundary 全屏覆盖（z-[100] "核心依赖熔断"），把画布盖死，截图永远拿不到 grid。
    // 用 route mock 给 hook 一个"凭证拿到了"的假象，hook 就不会进 fatal 分支。
    // 后续真正打到 meili host 时仍会失败，但 X 测试不触发任何 search 操作。
    await page.route('**/api/search/key', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          host: 'http://localhost:7700',
          search_key: 'mock-key-for-e2e',
        }),
      }),
    );

    await page.goto('/');
    await page.waitForFunction(() => window.__STORE__ !== undefined, { timeout: 10000 });

    // 强制确定性初态：清掉任何残留 part / phase
    await page.evaluate(() => window.__STORE__.getState().reset());

    // 等 R3F 一两个 RAF + 阴影/环境贴图 bake 完成
    await page.waitForTimeout(800);

    // 仅截取确定性的画布中央区域：
    //   - 跳过左 290px 物料库 / 暂存盘 panel
    //   - 跳过顶 80px 模式切换 + 右 250px GO SIMULATION 按钮
    //   - 跳过底 30px 状态栏 / Logs 按钮
    //   - 中心矩形完全是 R3F grid 像素，无 UI 干扰
    await expect(page).toHaveScreenshot('empty-assembly-canvas.png', {
      clip: { x: 400, y: 150, width: 700, height: 450 },
      maxDiffPixelRatio: 0.05,
      animations: 'disabled',
    });
  });
});

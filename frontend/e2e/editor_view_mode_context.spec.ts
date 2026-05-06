import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __STORE__: any;
  }
}

/**
 * D3 / D4 / D5 — view 切换 / mode 切换 / WebGL ContextLost
 *
 * 用户内部矩阵编号，反向定位：
 *   D3 → store.view ('ASSEMBLY' | 'LIBRARY_VERIFY')，App.jsx 据此渲染
 *        AssemblyUI+Canvas 或 LibraryNav+VerificationWorkbench。
 *   D4 → store.toggleMode 异步打 /api/toggle_mode；成功后 mode 翻转 +
 *        清 selectedPort / interactionPhase / continuousPlacementSource。
 *   D5 → WebGLRecoveryWatcher 监 canvas 'webglcontextlost'/'restored'
 *        事件 → setContextLost；App.jsx 据 isContextLost 渲染 z-[200]
 *        覆盖层 "WebGL Context Lost"。memoryManager.test.tsx 已覆盖
 *        store 层；e2e 在真 Chromium 验整套 React 副作用 + UI 链路。
 */
test.describe('View / Mode / ContextLost — D3/D4/D5', () => {

  test.beforeEach(async ({ page }) => {
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
    await page.waitForFunction(() => window.__STORE__ !== undefined);
    await page.waitForTimeout(500); // R3F mount + initial canvas
  });

  // ──────────────────────────────────────────────────────────────────────
  // D3 — view 切换
  // ──────────────────────────────────────────────────────────────────────
  test('D3-ViewSwitch: ASSEMBLY ↔ LIBRARY_VERIFY 可逆 + UI 切换', async ({ page }) => {
    // 用 view 独有 DOM 元素做 selector，不用 canvas 计数：
    //   ASSEMBLY → 不存在 LIBRARY_VERIFY 的"搜索零件" h3（VerificationWorkbench
    //              里写死的标题文本，稳定）
    //   LIBRARY_VERIFY → "搜索零件" h3 可见
    // 历史：第一版 toHaveCount(canvas, 0) 在 LIBRARY_VERIFY 失败——
    // VerificationWorkbench 内部也有 R3F Canvas（L5 import @react-three/fiber），
    // PartLibraryPanel 缩略图也是 canvas，全局 canvas 计数永远 ≥1。
    const libraryVerifyMarker = page.locator('h3', { hasText: '搜索零件' });

    // 默认 ASSEMBLY
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().view),
      { timeout: 2000 }
    ).toBe('ASSEMBLY');
    await expect(libraryVerifyMarker).toHaveCount(0);

    // 切到 LIBRARY_VERIFY
    await page.evaluate(() => window.__STORE__.getState().setView('LIBRARY_VERIFY'));
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().view),
      { timeout: 2000 }
    ).toBe('LIBRARY_VERIFY');
    await expect(libraryVerifyMarker).toBeVisible({ timeout: 3000 });

    // 切回 ASSEMBLY 验证可逆
    await page.evaluate(() => window.__STORE__.getState().setView('ASSEMBLY'));
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().view),
      { timeout: 2000 }
    ).toBe('ASSEMBLY');
    await expect(libraryVerifyMarker).toHaveCount(0, { timeout: 2000 });
  });

  // ──────────────────────────────────────────────────────────────────────
  // D4 — mode 切换
  // ──────────────────────────────────────────────────────────────────────
  test('D4-ModeToggle: ASSEMBLY ↔ SIMULATION + 交互态清空', async ({ page }) => {
    // toggleMode 异步打 /api/toggle_mode；CI 没后端必须 mock。
    await page.route('**/api/toggle_mode**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success' }),
      }),
    );

    // 注入交互中状态：part 选中 + selectedPort 非 null + 进 SOURCE_LOCKED。
    // toggleMode 成功后这三项必须被 store 清干净（仿真模式下保留交互
    // 状态会让 commit 触发未定义行为）。
    await page.evaluate(() => {
      const store = window.__STORE__.getState();
      store.reset();
      store.addParts(['mock_A']);
      store.updatePartState('mock_A', { position: [0, 0, 0] });
      store.selectPart('mock_A');
      window.__STORE__.setState({
        selectedPort: {
          partId: 'mock_A',
          ldrawId: 'mock_A.dat',
          portType: 'peg.dat',
          position: [0, 0, 0],
          rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
          globalPos: [0, 0, 0],
          globalQuat: [0, 0, 0, 1],
        },
        interactionPhase: 'SOURCE_LOCKED',
        continuousPlacementSource: { dummy: true }, // 任何非 null 即可
      });
    });

    // 默认 ASSEMBLY
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().mode),
      { timeout: 2000 }
    ).toBe('ASSEMBLY');

    // toggleMode → SIMULATION + 三项交互态清空
    await page.evaluate(() => window.__STORE__.getState().toggleMode());

    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().mode),
      { timeout: 3000 }
    ).toBe('SIMULATION');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().selectedPort),
      { timeout: 2000 }
    ).toBeNull();
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().interactionPhase),
      { timeout: 2000 }
    ).toBe('IDLE');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().continuousPlacementSource),
      { timeout: 2000 }
    ).toBeNull();

    // 再切回 ASSEMBLY 验证可逆
    await page.evaluate(() => window.__STORE__.getState().toggleMode());
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().mode),
      { timeout: 3000 }
    ).toBe('ASSEMBLY');
  });

  // ──────────────────────────────────────────────────────────────────────
  // D5 — WebGL ContextLost
  // ──────────────────────────────────────────────────────────────────────
  test('D5-ContextLost: webglcontextlost 触发 isContextLost + 显警示覆盖层', async ({ page }) => {
    // 默认未丢失
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().isContextLost),
      { timeout: 2000 }
    ).toBe(false);
    await expect(page.locator('text=WebGL Context Lost')).toHaveCount(0);

    // 在 R3F canvas 上 dispatch webglcontextlost。WebGLRecoveryWatcher
    // 监的是 useThree() 的 gl.domElement —— 同一个 canvas DOM 节点，
    // 直接 querySelector('canvas') 命中。事件构造用 cancelable:true 让
    // handler 里 preventDefault 不报错。
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('canvas not found');
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });

    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().isContextLost),
      { timeout: 2000 }
    ).toBe(true);
    // App.jsx L225 的 z-[200] 警示覆盖层应当出现，含稳定 h2 文本。
    await expect(page.locator('h2', { hasText: 'WebGL Context Lost' }))
      .toBeVisible({ timeout: 2000 });

    // dispatch restored → 恢复
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('canvas not found');
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    });

    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().isContextLost),
      { timeout: 2000 }
    ).toBe(false);
    await expect(page.locator('text=WebGL Context Lost')).toHaveCount(0, { timeout: 2000 });
  });
});

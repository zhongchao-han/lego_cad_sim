import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __STORE__: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __PERSIST__: any;
  }
}

/**
 * E3 — IndexedDB reload (zustand persist 防损坏持久化端到端)
 *
 * store.ts 配置 persist middleware：
 *   key: 'lego-cad-assembly-storage'
 *   storage: 防损坏 IndexedDB 双槽适配器（persistence/safeStorage.ts）
 *   partialize: parts / connections(Set→Array) / occupiedPorts /
 *               activeColorCode / cameraTarget / partUsages /
 *               hiddenParts(Set→Array)
 *   merge: Array → Set 反序列化（connections + hiddenParts）
 *   onRehydrateStorage: 重建 stagingGrid + addLog "State rehydrated…"
 *
 * 不持久化：interactionPhase / selectedPort / continuousPlacementSource
 *           / view / mode / clipboard 等交互态。
 *
 * 测试核心三个持久化字段 + 临时字段 reset + 'State rehydrated' log。
 * 注意：写入经 debounce（800ms），故注入后调 __PERSIST__.flush() 等落盘再 reload。
 */
test.describe('Persistence — E3 IndexedDB reload', () => {

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
    // Playwright 默认每个 test 拿 fresh context（含 fresh IndexedDB），
    // 但显式删一下兜底，避免上一轮残留污染 hydrate。
    await page.evaluate(async () => {
      localStorage.clear();
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('lego-cad-persist');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    });
    await page.reload();
    await page.waitForFunction(() => window.__STORE__ !== undefined);
    await page.waitForTimeout(200);
  });

  test('E3-LocalStorageReload: persisted state survives reload, transient state resets', async ({ page }) => {
    // ── 注入 baseline：持久化字段 + 临时字段 ──────────────────────────────
    await page.evaluate(() => {
      const store = window.__STORE__.getState();
      store.reset();
      store.addParts(['mock_A']);
      store.updatePartState('mock_A', { position: [0, 0, 0] });
      store.addParts(['mock_B']);
      store.updatePartState('mock_B', { position: [0.05, 0, 0] });

      // 写 connections（Set 字段，验证 Set→Array→Set 往返序列化）
      store.connectParts('mock_A', 'porta', 'mock_B', 'portb');

      // 写 hiddenParts（另一个 Set 字段）：选中 B 后调 setHiddenSelected(true)
      store.selectPart('mock_B');
      store.setHiddenSelected(true);

      // 写 interactionPhase / selectedPort / continuousPlacementSource
      // 这三项是临时字段，不会被持久化，reload 后必须重置回默认。
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
        continuousPlacementSource: { dummy: true },
      });
    });

    // ── pre-reload baseline 断言（确认我们真注入了，不是 reload 后默认就这样）──
    const pre = await page.evaluate(() => {
      const s = window.__STORE__.getState();
      return {
        partsCount: Object.keys(s.parts).length,
        connectsToB: s.connections.mock_A instanceof Set
          ? s.connections.mock_A.has('mock_B')
          : false,
        hiddenHasB: s.hiddenParts instanceof Set
          ? s.hiddenParts.has('mock_B')
          : false,
        phase: s.interactionPhase,
        hasSelectedPort: s.selectedPort !== null,
      };
    });
    expect(pre.partsCount).toBe(2);
    expect(pre.connectsToB).toBe(true);
    expect(pre.hiddenHasB).toBe(true);
    expect(pre.phase).toBe('SOURCE_LOCKED');
    expect(pre.hasSelectedPort).toBe(true);

    // ── 等防损坏存储把 debounced 写入落盘（双槽 + checksum）再 reload ──────
    await page.evaluate(() => window.__PERSIST__.flush());

    // ── reload：触发 zustand persist rehydrate ────────────────────────────
    // page.route 在 navigation 之间保留（Playwright 文档保证）。
    await page.reload();
    await page.waitForFunction(() => window.__STORE__ !== undefined);

    // 等 onRehydrateStorage 跑完（addLog 写入 logs 数组），用作 hydrate
    // 完成的可观测信号。expect.poll 给序列化反序列化 + Set 重建留时间。
    await expect.poll(
      () => page.evaluate(() => {
        const s = window.__STORE__.getState();
        return s.logs.some((l: { message: string }) =>
          l.message.includes('State rehydrated')
        );
      }),
      { timeout: 5000 }
    ).toBe(true);

    // ── post-reload 断言 ──────────────────────────────────────────────────
    const post = await page.evaluate(() => {
      const s = window.__STORE__.getState();
      return {
        // 核心持久化字段三件套
        partsCount: Object.keys(s.parts).length,
        connectionsIsSet: s.connections.mock_A instanceof Set,
        connectsToB: s.connections.mock_A instanceof Set
          ? s.connections.mock_A.has('mock_B')
          : false,
        hiddenIsSet: s.hiddenParts instanceof Set,
        hiddenHasB: s.hiddenParts instanceof Set
          ? s.hiddenParts.has('mock_B')
          : false,
        // 临时字段 reset 验证
        phase: s.interactionPhase,
        selectedPort: s.selectedPort,
        continuousPlacementSource: s.continuousPlacementSource,
      };
    });

    // 持久化字段恢复 + Set 类型 merge 转回正确
    expect(post.partsCount).toBe(2);
    expect(post.connectionsIsSet).toBe(true);
    expect(post.connectsToB).toBe(true);
    expect(post.hiddenIsSet).toBe(true);
    expect(post.hiddenHasB).toBe(true);

    // 临时字段全部重置回默认
    expect(post.phase).toBe('IDLE');
    expect(post.selectedPort).toBeNull();
    expect(post.continuousPlacementSource).toBeNull();
  });
});

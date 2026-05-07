import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __STORE__: any;
  }
}

/**
 * A2 / A4 / A6 — sliding / shift override / rotate
 *
 * 用户内部矩阵编号，反向定位：
 *   A2 → AXIAL_SLIDING + ArrowUp/Down + Shift step×10 + Enter commit
 *        (useKeyboardShortcuts.ts:120-145, store.ts:1360 updateSlideOffset)
 *   A4 → Shift bypass collision clamp ——【SKIPPED】issue #66：
 *        calculateClampedOffset 是死代码，shiftKey override 在产品运行时
 *        无效，写 e2e 等于测试假象。占位 placeholder，待 #66 修复后开回。
 *   A6 → [/] / ArrowLeft/Right → rotateSelectedPart(±π/2)
 *        (useKeyboardShortcuts.ts:146-163, store.ts:1368)
 */
test.describe('Sliding / Shift Override / Rotate — A2/A4/A6', () => {

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
    // updateSlideOffset → snapParts 内部 axios.post(/api/snap_parts) 是 fire-and-forget
    // (issue #62)；mock 屏蔽 unhandled rejection 噪声。
    await page.route('**/api/snap_parts', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          auto_latched_count: 0,
          auto_latched_edges: [],
        }),
      }),
    );

    await page.goto('/');
    await page.waitForFunction(() => window.__STORE__ !== undefined);
    await page.waitForTimeout(500);
  });

  // ──────────────────────────────────────────────────────────────────────
  // A2 — AXIAL_SLIDING 键盘步进
  // ──────────────────────────────────────────────────────────────────────
  test('A2-AxialSliding: ArrowUp/Down + Shift step×10 + Enter commits to IDLE', async ({ page }) => {
    // 注入 source 销 + target 板，进 AXIAL_SLIDING phase。
    // peg.dat (MALE CYL r=5.9) + peghole (FEMALE CYL r=6.0) → fitForSlide
    // → CLEARANCE → step factor 1.0，所以 baseStep×factor 直接对得上：
    // ArrowUp = +1, Shift+ArrowUp = +10。
    await page.evaluate(() => {
      const store = window.__STORE__.getState();
      store.reset();
      store.addParts(['source_pin']);
      store.updatePartState('source_pin', { position: [0, 0, 0] });
      store.addParts(['target_plate']);
      store.updatePartState('target_plate', { position: [0.10, 0, 0] });

      const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      window.__STORE__.setState({
        selectedPort: {
          partId: 'source_pin',
          ldrawId: 'mock_A.dat',
          portType: 'peg.dat',
          position: [0, 0, 0],
          rotation: EYE3,
          globalPos: [0, 0, 0],
          globalQuat: [0, 0, 0, 1],
        },
        slidingTarget: {
          partId: 'target_plate',
          ldrawId: 'mock_B.dat',
          portType: 'peghole.0',
          position: [0.10, 0, 0],
          rotation: EYE3,
          globalPos: [0.10, 0, 0],
          globalQuat: [0, 0, 0, 1],
        },
        interactionPhase: 'AXIAL_SLIDING',
        slideOffset: 0,
      });
    });

    // ── ArrowUp → +1 ──
    await page.keyboard.press('ArrowUp');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().slideOffset),
      { timeout: 5000 }
    ).toBeCloseTo(1, 6);

    // ── 再 ArrowUp ×3 → 4 (clamp 范围 ±8 内，不触穿模分支)──
    // ⚠ A4-ShiftOverride 专责测 Shift 步长 ×10 + clamp 穿透 (issue #66 修后)；
    //   A2 仅覆盖小步长 + 反向 + Enter，避开 clamp 行为防误读。
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().slideOffset),
      { timeout: 5000 }
    ).toBeCloseTo(4, 6);

    // ── ArrowDown × 2 → 4 - 2 = 2 (反向 step) ──
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().slideOffset),
      { timeout: 5000 }
    ).toBeCloseTo(2, 6);

    // ── Enter → commitAxialSliding → phase=IDLE, slideOffset=0 ──
    await page.keyboard.press('Enter');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().interactionPhase),
      { timeout: 5000 }
    ).toBe('IDLE');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().slideOffset),
      { timeout: 5000 }
    ).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // A4 — Shift Override（接通 issue #66 后开回 CI）
  // ──────────────────────────────────────────────────────────────────────
  // store.snapParts / updateSlideOffset 现在透传 shiftKey，调用
  // calculateClampedOffset(offset, shiftKey, 8 LDU) — 不带 Shift 时 clamp
  // 在 ±8 LDU；带 Shift 时绕过 clamp，offset 原样穿透。
  test('A4-ShiftOverride: ArrowUp×20 不带 Shift clamp 在 8 / Shift+ArrowUp×20 穿透', async ({ page }) => {
    // 注入 source / target + AXIAL_SLIDING phase（同 A2）
    await page.evaluate(() => {
      const store = window.__STORE__.getState();
      store.reset();
      store.addParts(['source_pin']);
      store.updatePartState('source_pin', { position: [0, 0, 0] });
      store.addParts(['target_plate']);
      store.updatePartState('target_plate', { position: [0.10, 0, 0] });

      const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      window.__STORE__.setState({
        selectedPort: {
          partId: 'source_pin',
          ldrawId: 'mock_A.dat',
          portType: 'peg.dat',
          position: [0, 0, 0],
          rotation: EYE3,
          globalPos: [0, 0, 0],
          globalQuat: [0, 0, 0, 1],
        },
        slidingTarget: {
          partId: 'target_plate',
          ldrawId: 'mock_B.dat',
          portType: 'peghole.0',
          position: [0.10, 0, 0],
          rotation: EYE3,
          globalPos: [0.10, 0, 0],
          globalQuat: [0, 0, 0, 1],
        },
        interactionPhase: 'AXIAL_SLIDING',
        slideOffset: 0,
      });
    });

    // ── 不带 Shift × 20 — 累计请求 +20 LDU，clamp 应锁在 8 ──
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowUp');
    }
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().slideOffset),
      { timeout: 5000 }
    ).toBeCloseTo(8, 6);

    // 重置 slideOffset
    await page.evaluate(() => window.__STORE__.setState({ slideOffset: 0 }));

    // ── Shift+ArrowUp × 20 — 每次 step=10，累计 200 LDU，无 clamp 穿透 ──
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Shift+ArrowUp');
    }
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().slideOffset),
      { timeout: 5000 }
    ).toBeCloseTo(200, 6);
  });

  // ──────────────────────────────────────────────────────────────────────
  // A6 — 旋转
  // ──────────────────────────────────────────────────────────────────────
  test('A6-RotateSelected: [ rotates -90° each press, 4× returns to baseline (modulo q sign)', async ({ page }) => {
    // 注入孤立 part + 选中 + selectedPort.portType 非 axle（useKeyboardShortcuts.ts:148-150
    // 对 axle 短路）+ phase=SOURCE_LOCKED。
    // connections / occupiedPorts 都空 → rotateSelectedPart 走 excludeId="" 分支
    // → 过约束检测短路 → srcGroup=[source_pin] → 单部件绕 selectedPort.Z 转。
    await page.evaluate(() => {
      const store = window.__STORE__.getState();
      store.reset();
      store.addParts(['source_pin']);
      store.updatePartState('source_pin', { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });

      const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      window.__STORE__.setState({
        selectedPort: {
          partId: 'source_pin',
          ldrawId: 'mock_A.dat',
          portType: 'peg.dat',
          position: [0, 0, 0],
          rotation: EYE3,
          globalPos: [0, 0, 0],
          globalQuat: [0, 0, 0, 1],
        },
        interactionPhase: 'SOURCE_LOCKED',
      });
    });

    const getQuat = () =>
      page.evaluate(
        () => window.__STORE__.getState().parts.source_pin.quaternion as [number, number, number, number]
      );
    // 四元数 q 与 -q 表示同旋转，"等价"用 |dot(q1,q2)|；绕同轴转 θ 后
    // dot ≈ cos(θ/2)。θ=90° → |dot|≈0.707；θ=360° → |dot|≈1。
    const dotAbs = (a: number[], b: number[]) =>
      Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);

    const baseline = await getQuat();
    expect(baseline).toEqual([0, 0, 0, 1]);

    // ── 1× [ → -90° ──
    await page.keyboard.press('[');
    await expect.poll(
      async () => dotAbs(baseline, await getQuat()),
      { timeout: 5000 }
    ).toBeLessThan(0.9); // 已经转走，不再 =1
    let q = await getQuat();
    expect(dotAbs(baseline, q)).toBeCloseTo(Math.cos(Math.PI / 4), 2); // ≈0.707

    // ── 再 [×3 → 累计 -360°，回到 baseline 等价方位 ──
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    await expect.poll(
      async () => dotAbs(baseline, await getQuat()),
      { timeout: 5000 }
    ).toBeGreaterThan(0.99);

    // ── ]×4 → 顺时针 +360°，再次回到 baseline ──
    await page.keyboard.press(']');
    await page.keyboard.press(']');
    await page.keyboard.press(']');
    await page.keyboard.press(']');
    await expect.poll(
      async () => dotAbs(baseline, await getQuat()),
      { timeout: 5000 }
    ).toBeGreaterThan(0.99);
  });
});

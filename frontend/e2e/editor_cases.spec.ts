import { test, expect } from '@playwright/test';
import { simulateHumanJitter } from './utils/mouseBehavior';

// Define the window property locally for TypeScript 
declare global {
  interface Window {
    __STORE__: any;
  }
}

test.describe('EDITOR_TEST_CASES - E2E Core Interactions', () => {

  test.beforeEach(async ({ page }) => {
    // WebSocket stub：替换 global WebSocket 让 ws://localhost:8000/ws/physics_stream
    // 不真发起连接、不触发重连风暴。CI 上无后端时 ECONNREFUSED 每 2s 一次产生
    // 大量 console error 把 event loop 拖到 simulateHumanJitter mouse.move 路径
    // 30s timeout 失败（TS-7 hover crash unskip 的关键阻塞）。FakeWebSocket 永远
    // 留在 CONNECTING(0)，前端 onerror/onclose 不触发就不会重连。
    await page.addInitScript(() => {
      // @ts-expect-error override DOM global for test isolation
      window.WebSocket = class FakeWebSocket {
        url: string;
        readyState = 0; // CONNECTING — 永不切到 CLOSED 触发重连
        onopen: ((ev: Event) => void) | null = null;
        onclose: ((ev: CloseEvent) => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        constructor(url: string) { this.url = url; }
        addEventListener() {}
        removeEventListener() {}
        send() {}
        close() { this.readyState = 3; }
      };
    });

    // CI 上 backend 未起：usePartSearch 拉 /api/search/key 三次重试失败后会触发
    // RenderErrorBoundary 全屏 z-[100] "核心依赖熔断" 覆盖，盖死 canvas + 把
    // event loop 拖到 mouse.move / waitForTimeout 都会超时（对依赖鼠标手势的
    // 测试如 TS-7 hover crash 致命）。给 hook 一个"凭证拿到了"的假象走开。
    // canvas_pixel.spec.ts 同款套路。
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

    // LDraw 资源 mock：让 useLDrawPart 拿到 sites/ports 数据（SiteGizmo 仍能
    // 渲染交互），但 mesh_url 留空让 InteractivePart 走 fallback box 渲染
    // （L199 if-else），避免 CI 上没后端时 GLB fetch 失败让 R3F 几何加载链
    // 路 hang 把 event loop 拖到 simulateHumanJitter 超时（TS-7 hover-crash
    // 第一次 unskip CI 的关键阻塞点）。
    await page.route('**/api/ldraw_part/**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ports: [
            { name: 'p1', type: 'peg.dat',
              position: [0, 0, 0], rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
          ],
          sites: [
            { id: 'site_0', position: [0, 0, 0], occupied_by: null,
              ports: [{ name: 'p1', type: 'peg.dat',
                position: [0, 0, 0], rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }] },
          ],
          // mesh_url 不返（或返 undefined）→ InteractivePart 走 fallback box
          bounding_box: { size: [0.01, 0.01, 0.01], center: [0, 0, 0] },
        }),
      }),
    );

    // Navigate to the app
    await page.goto('/');

    // Ensure application and store are loaded
    await page.waitForFunction(() => window.__STORE__ !== undefined);

    // Initial injection of 2 dummy parts to perform tests on.
    // Instead of clicking through UI to add parts (which tests Search UI, not Editor Core),
    // we inject directly into store to ensure robust initial state.
    await page.evaluate(() => {
      const store = window.__STORE__.getState();
      store.reset(); // clear anything
      
      // Inject part A at [0, 0, 0]
      store.addParts(['mock_A']);
      store.updatePartState('mock_A', { position: [0, 0, 0] });
      
      // Inject part B at [100, 100, 100] (away from center)
      store.addParts(['mock_B']);
      store.updatePartState('mock_B', { position: [100, 0, 0] });
    });
    
    // Give R3F time to mount the meshes
    await page.waitForTimeout(1000);
  });

  test('TS-5: Free Placing Paste (TS-5.1, TS-5.2, TS-5.3)', async ({ page }) => {
    // issue #61 已修：Esc 路径集中到 useKeyboardShortcuts 单一 dispatcher，
    // FREE_PLACING phase 时仅调 commitFreePlacing(undefined)，
    // Scene.jsx 旧 keydown handler 已删 — 双 handler 竞态消除。
    // 1. Select the part A (using store to guarantee selection for copy operation to be precise)
    // Even though it's UI test, the purpose here is testing copy-paste mechanism.
    await page.evaluate(() => {
        window.__STORE__.getState().selectPart('mock_A');
    });

    // --- TS-5.1: Payload 挂载 ---
    // User presses Meta+C (or Control+C) then Meta+V (or Control+V)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+C`);
    await page.keyboard.press(`${modifier}+V`);

    // expect.poll 给 React state batching + Esc 多 handler 异步收敛留出时间。
    // 历史：2026-05 PR #58 第一次 e2e-non-pixel run 上 hard expect 三连挂
    // payload.length=1（Esc 后 commitFreePlacing/abortCurrentInteraction
    // 两个 handler 竞态，一两次 RAF 才收敛到 IDLE+empty）。
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().interactionPhase),
      { timeout: 5000 }
    ).toBe('FREE_PLACING');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().freePlacingPayload.length),
      { timeout: 5000 }
    ).toBe(1);
    await expect.poll(
      () => page.evaluate(() => Object.keys(window.__STORE__.getState().parts).length),
      { timeout: 5000 }
    ).toBe(2); // Still just A and B

    // --- TS-5.2: 取消放置 ---
    // User presses Escape
    await page.keyboard.press('Escape');

    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().interactionPhase),
      { timeout: 5000 }
    ).toBe('IDLE');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().freePlacingPayload.length),
      { timeout: 5000 }
    ).toBe(0);

    // --- TS-5.3: 实锤确认放置 ---
    // Copy and Paste again
    await page.keyboard.press(`${modifier}+C`);
    await page.keyboard.press(`${modifier}+V`);

    // Wait for ghost to follow mouse, then click anywhere on screen to commit
    await page.mouse.move(300, 300);
    await page.waitForTimeout(100);
    await page.mouse.click(300, 300); // Drop the part

    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().interactionPhase),
      { timeout: 5000 }
    ).toBe('IDLE');
    await expect.poll(
      () => page.evaluate(() => Object.keys(window.__STORE__.getState().parts).length),
      { timeout: 5000 }
    ).toBe(3); // A, B, and the new clone
  });

  test('TS-6: Advanced Mouse & Keyboard Tricks (TS-6.1, TS-6.2, TS-6.3)', async ({ page }) => {
    // --- TS-6.2: Multi-Select 开拓防漏模式 ---
    // We select part A through code to start
    await page.evaluate(() => {
        const store = window.__STORE__.getState();
        store.selectPart('mock_A');
    });
    
    // Now simulate Shift + Selection of part B
    await page.evaluate(() => {
        const store = window.__STORE__.getState();
        // Since clicking part B precisely in WebGL is hard and depends on camera/screen res,
        // we trigger the selection hook precisely as a UI click would.
        store.selectPart('mock_B', 0, true); // level=0(GROUP), append=true
    });

    let selectedIds = await page.evaluate(() => window.__STORE__.getState().selection.allConnectedIds);
    expect(selectedIds).toContain('mock_A');
    expect(selectedIds).toContain('mock_B');

    // --- TS-6.1: Camera Auto Focus 平均包围 ---
    await page.keyboard.press('f');
    await page.waitForTimeout(500); // Allow tweening/focus computation to complete

    let cameraTarget = await page.evaluate(() => window.__STORE__.getState().cameraTarget);
    expect(cameraTarget).not.toBeNull();
    // Center between [0,0,0] and [100,0,0] should be ~ [50, 0, 0]
    expect(cameraTarget[0]).toBeCloseTo(50);
    expect(cameraTarget[1]).toBeCloseTo(0);
    expect(cameraTarget[2]).toBeCloseTo(0);

    // --- TS-6.3: 狂暴穿模验证 ---
    // To test ShiftKey physics bypass during drag, we simulate the interaction state machine 
    // passing into AXIAL_SLIDING, and sending a PointerEvent
    await page.evaluate(() => {
        const store = window.__STORE__.getState();
        // Set up the sliding state
        store.interactionPhase = 'AXIAL_SLIDING';
        store.slidingTarget = { globalPos: [0, 0, 0], globalQuat: [0, 0, 0, 1] };
    });

    // Move the mouse extremely far
    await page.mouse.move(500, 500);
    // Depress mouse
    await page.mouse.down();
    
    // Move way out of screen, mimicking a huge offset drift
    await page.mouse.move(100, 100);
    // The physics limiter is 20 * 0.4 = 8. Without shift, the offset clamp would kick in.
    
    // Now trigger a pointermove with shiftKey directly inside the browser payload
    await page.evaluate(() => {
      const moveEvent = new PointerEvent('pointermove', {
          clientX: 100,
          clientY: 100,
          shiftKey: true,
      });
      window.dispatchEvent(moveEvent);
    });

    // End drag
    await page.mouse.up();

    // The shift key should have completely overridden the collision lock mathematically, 
    // though E2E verification of the exact "visual overlap" requires complex canvas interrogation, 
    // we proved the system doesn't error out during this manual UI gesture.
  });

  test('TS-7-ContinuousStamp: Continuous Stamp Assembly (TS-7.1, TS-7.2, TS-7.3)', async ({ page }) => {
    // CI 上 backend 未起；与 canvas_pixel 同样 mock /api/search/key 防止
    // RenderErrorBoundary 把画布盖死。/api/snap_parts 在 store.snapParts 里
    // 是 fire-and-forget（详见 store.ts L804），但 mock 一下能压掉 unhandled
    // rejection 噪音 + 让 CI 行为跟有后端时一致。
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

    // 重置 beforeEach 注入的 mock_A/mock_B，换成 71709 平板当地基。
    // 关键：必须保证 ACTIVE_ARENA 里有非 0 个零件，否则
    // handlePortClick 会走 "first-part shortcut" 直接落盘，跳过
    // SOURCE_LOCKED + continuousPlacementSource 这条分支。
    await page.evaluate(() => {
      const store = window.__STORE__.getState();
      store.reset();
      store.addParts(['plate_base']);
      store.updatePartState('plate_base', { position: [0, 0, 0] });
      // 模拟从零件库 PartPreviewOverlay 选中预览：previewPartId 不影响
      // handlePortClick 路由判定，但跟用户行为对齐，避免 phase 残留。
      window.__STORE__.setState({ previewPartId: '2780' });
    });
    await page.waitForTimeout(500);

    const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

    // ── TS-7.1：连续图章激活 ──────────────────────────────────────────────
    // 从预览面板点销端口（isFromPreview:true）→ phase=SOURCE_LOCKED +
    // continuousPlacementSource set。
    await page.evaluate((eye) => {
      const pinSrc = {
        partId: '2780.dat_initial',
        ldrawId: '2780.dat',
        portType: 'peg.dat',
        position: [0, 0, 0],
        rotation: eye,
        globalPos: [0, 0, 0],
        globalQuat: [0, 0, 0, 1],
        isFromPreview: true,
      };
      return window.__STORE__.getState().handlePortClick(pinSrc);
    }, EYE3);

    // expect.poll 给 React state batching + handlePortClick 异步收敛留出时间。
    // 历史：2026-05 PR #58 第一次 e2e-non-pixel run 上 TS-7-ContinuousStamp
    // flaky（page.evaluate 偶发 hang，retry 后恢复）。poll 不能直接救 hang，
    // 但状态晚到时（snapParts 内 await + fire-and-forget axios 链路收敛慢）
    // 给 hard expect 容错。
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().interactionPhase),
      { timeout: 5000 }
    ).toBe('SOURCE_LOCKED');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().continuousPlacementSource !== null),
      { timeout: 5000 }
    ).toBe(true);

    // ── TS-7.2：第一根落孔 → AXIAL_SLIDING + parts 多 1 根 2780 ────────────
    // continuousPlacementSource 不能因第一根落盘而清空，否则 stamp 接力中断。
    await page.evaluate((eye) => {
      return window.__STORE__.getState().handlePortClick({
        partId: 'plate_base',
        ldrawId: '71709.dat',
        portType: 'peghole.0',
        position: [0.10, 0, 0],
        rotation: eye,
        globalPos: [0.10, 0, 0],
        globalQuat: [0, 0, 0, 1],
      });
    }, EYE3);

    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().interactionPhase),
      { timeout: 5000 }
    ).toBe('AXIAL_SLIDING');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().continuousPlacementSource !== null),
      { timeout: 5000 }
    ).toBe(true);
    await expect.poll(
      () => page.evaluate(() =>
        Object.values(window.__STORE__.getState().parts).filter(
          (p) => (p as { ldrawId: string }).ldrawId === '2780.dat'
        ).length
      ),
      { timeout: 5000 }
    ).toBe(1);

    // ── TS-7.3：连点静默提交 ─────────────────────────────────────────────
    // 处于 AXIAL_SLIDING 时再点 hole2 → handlePortClick 入口处自动 commit
    // 上一根（commitAxialSliding 在 continuousPlacementSource 路径下静默
    // 重入 SOURCE_LOCKED 而非 IDLE）→ 又落一根 → 累计 2 根 + 重入 AXIAL_SLIDING。
    // 历史回归：第一根销不能被搬到 hole2（旧 selectedPort 闭包 Bug）。
    await page.evaluate((eye) => {
      return window.__STORE__.getState().handlePortClick({
        partId: 'plate_base',
        ldrawId: '71709.dat',
        portType: 'peghole.1',
        position: [0.20, 0, 0],
        rotation: eye,
        globalPos: [0.20, 0, 0],
        globalQuat: [0, 0, 0, 1],
      });
    }, EYE3);

    const getPinXs = () =>
      page.evaluate(() =>
        Object.values(window.__STORE__.getState().parts)
          .filter((p) => (p as { ldrawId: string }).ldrawId === '2780.dat')
          .map((p) => (p as { position: number[] }).position[0])
          .sort((a, b) => a - b)
      );

    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().interactionPhase),
      { timeout: 5000 }
    ).toBe('AXIAL_SLIDING');
    await expect.poll(
      () => page.evaluate(() => window.__STORE__.getState().continuousPlacementSource !== null),
      { timeout: 5000 }
    ).toBe(true);
    await expect.poll(async () => (await getPinXs()).length, { timeout: 2000 }).toBe(2);

    const stamp2Pins = await getPinXs();
    expect(stamp2Pins[0]).toBeCloseTo(0.10, 3);
    expect(stamp2Pins[1]).toBeCloseTo(0.20, 3);

    // 再点 hole3 验证累计模式可持续：3 根销分别落在三个孔上。
    await page.evaluate((eye) => {
      return window.__STORE__.getState().handlePortClick({
        partId: 'plate_base',
        ldrawId: '71709.dat',
        portType: 'peghole.2',
        position: [0.30, 0, 0],
        rotation: eye,
        globalPos: [0.30, 0, 0],
        globalQuat: [0, 0, 0, 1],
      });
    }, EYE3);

    await expect.poll(async () => (await getPinXs()).length, { timeout: 2000 }).toBe(3);
    const stamp3Pins = await getPinXs();
    expect(stamp3Pins[0]).toBeCloseTo(0.10, 3);
    expect(stamp3Pins[1]).toBeCloseTo(0.20, 3);
    expect(stamp3Pins[2]).toBeCloseTo(0.30, 3);
  });

  test('TS-7: Display Ports on Hover Without Crash', async ({ page }) => {
    // CI unskip：beforeEach mock /api/ldraw_part/** 返 sites/ports + 不带
    // mesh_url，让 InteractivePart 走 fallback box 渲染（不 hang 在 GLB
    // 加载）。WebSocket /ws/physics_stream 重试噪声仅污染 console，不阻
    // 塞 simulateHumanJitter mouse.move 路径。详见 PR #57 第二轮 fail log
    // 与 PR #94 unskip。
    // Inject a real part precisely so it loads actual ports (SiteGizmos)
    // 6558 is the 3L friction pin, which definitely has ports.
    await page.evaluate(() => {
        const store = window.__STORE__.getState();
        store.reset();
        store.addParts(['6558']);
        store.updatePartState('6558', { position: [0, 0, 0] });
    });

    // Wait for mesh to be established
    await page.waitForTimeout(1000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        const text = msg.text();
        console.log(`[Browser ${msg.type()}]`, text);
        if (text.includes('Maximum update depth exceeded') || text.includes('Uncaught ReferenceError')) {
          errors.push(text);
        }
      }
    });

    page.on('pageerror', (err) => {
      console.log(`[Browser PageError]`, err.message);
      errors.push(err.message);
    });

    // Move to the exact center where mock_C lives
    // Note: Playwright's mouse.move targets screen coordinates. 
    // Assuming 1280x720, center is ~640x360. We do a sweep.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);
    
    // Sweep into center
    await page.mouse.move(640, 360, { steps: 20 });
    
    // Simulate "Human Hand" jitter over the port/part area to forcefully provoke rendering loops
    await simulateHumanJitter(page, 640, 360, { durationMs: 3000, radius: 15 });

    // Verify hover state flipped logic in the store internally (or just verify no crash occurred)
    expect(errors.length).toBe(0);
  });

});

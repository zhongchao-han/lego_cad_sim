import { test, expect } from '@playwright/test';

test.describe('Part Hover Interaction', () => {
  test('should not throw React Maximum update depth exceeded or Uncaught Reference errors', async ({ page }) => {
    const logs: string[] = [];
    const errors: string[] = [];

    // Listen to console and page errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore specific framework/dev warnings that aren't critical unless they are the specific React depth issue
        if (text.includes('Maximum update depth exceeded') || text.includes('Uncaught ReferenceError')) {
          errors.push(text);
        }
      }
    });

    page.on('pageerror', (err) => {
      errors.push(err.message);
    });

    await page.goto('/');

    // Wait for the application to render
    await page.waitForSelector('button', { timeout: 10000 });
    
    // Attempt to select the first part from the library
    const buttons = await page.$$('.group.flex.items-center'); // specific to the part list items
    if (buttons.length > 0) {
      await buttons[0].click({ force: true });
    }

    // Wait for the 3D scene to load the part
    await page.waitForTimeout(3000);

    // Perform rapid hovers over the center where the part and its ports should be
    await page.mouse.move(500, 500);
    await page.waitForTimeout(200);
    await page.mouse.move(505, 505);
    await page.waitForTimeout(200);
    await page.mouse.move(510, 510);
    await page.waitForTimeout(500);

    // One more sweep to ensure gizmos get hit
    await page.mouse.move(500, 500);
    await page.mouse.move(480, 480, { steps: 10 });
    await page.mouse.move(520, 520, { steps: 10 });
    await page.waitForTimeout(500);

    // Assert there are no critical errors
    expect(errors.length).toBe(0);
  });
});

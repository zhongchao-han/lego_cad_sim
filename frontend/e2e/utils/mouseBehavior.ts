import { Page } from '@playwright/test';

export interface JitterOptions {
  radius?: number;      // 抖动半径（像素）
  durationMs?: number;  // 持续总时长 (毫秒)
  frequencyMs?: number; // 每次抽搐的间隔频率
}

/**
 * 通用：模拟帕金森/人类手抖机制 (高频随机坐标微扰)
 * 专门用于在 E2E 测试中暴露由于 React 频繁挂载/卸载或边界重叠引发的死循环 Bug
 * 
 * @param page Playwright Virtual Page
 * @param centerX 目标热区 X 坐标
 * @param centerY 目标热区 Y 坐标
 * @param options 抖动配置
 */
export async function simulateHumanJitter(
  page: Page, 
  centerX: number, 
  centerY: number, 
  options: JitterOptions = {}
) {
  const { radius = 10, durationMs = 3000, frequencyMs = 100 } = options;
  const steps = Math.floor(durationMs / frequencyMs);

  for (let i = 0; i < steps; i++) {
    const rx = centerX + (Math.random() - 0.5) * 2 * radius;
    const ry = centerY + (Math.random() - 0.5) * 2 * radius;
    
    // 使用随机游走步长，使轨迹更加不可预测，有效打破固定的动画时序约束
    await page.mouse.move(rx, ry, { steps: Math.floor(Math.random() * 3) + 1 });
    await page.waitForTimeout(frequencyMs);
  }
}

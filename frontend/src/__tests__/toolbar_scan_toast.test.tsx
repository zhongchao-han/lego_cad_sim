import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { Toolbar } from '../components/Toolbar';
import { useStore } from '../store';

/**
 * 「检测未连接」结果 toast：点按钮后无论有没有检出都要给可见提示。
 * 用真实 store（test 环境下 clear-on-edit 订阅本就不挂），仅覆写 scanMissedLatches
 * 控制扫描结果，断言 Toolbar 弹出的 toast 文案与配色。
 */
describe('Toolbar 检测未连接 toast', () => {
  beforeEach(() => {
    // ≥2 件 → 按钮可点；清空漏连结果。其余字段用 store 默认（IDLE、无选中）。
    useStore.setState({ parts: { p1: {}, p2: {} } as never, missedLatchPairs: [] });
  });

  it('检出时弹琥珀色 toast 并报数量', async () => {
    useStore.setState({
      scanMissedLatches: async () => { useStore.setState({ missedLatchPairs: [{ a: 'p1', b: 'p2' }] }); },
    });

    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('tb-scan-missed'));

    const toast = await screen.findByTestId('scan-missed-toast');
    expect(toast.textContent).toContain('检测到 1 处未连接');
    expect(toast.className).toContain('amber');
  });

  it('未检出时弹中性 toast「未发现未连接的件」', async () => {
    useStore.setState({
      scanMissedLatches: async () => { useStore.setState({ missedLatchPairs: [] }); },
    });

    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('tb-scan-missed'));

    const toast = await screen.findByTestId('scan-missed-toast');
    expect(toast.textContent).toContain('未发现未连接的件');
    expect(toast.className).not.toContain('amber');
  });
});

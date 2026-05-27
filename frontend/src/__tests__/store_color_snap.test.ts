import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { useStore } from '../store';
import { ZoneType } from '../types';

vi.mock('axios');

describe('store.snapParts — 零件颜色状态转移验证', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      activeColorCode: 4, // 模拟用户全局画笔设定为红色 (4)
      parts: {
        'target.dat': {
          ldrawId: 'target.dat',
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          colorCode: 7, // 底板是灰色或别的颜色
          zone: ZoneType.ACTIVE_ARENA,
        },
      },
      connections: {},
    } as any);

    // 默认通过后端 snap
    (vi.mocked(axios).post as any).mockResolvedValue({
      data: { status: 'success' },
    });
  });

  const makeMockPort = (partId: string, ldrawId?: string) => ({
    partId,
    ldrawId: ldrawId || partId,
    portType: 'peg.dat',
    position: [0, 0, 0] as any,
    rotation: [[1,0,0],[0,1,0],[0,0,1]] as any,
    globalPos: [0, 1, 0] as any,
    globalQuat: [0, 0, 0, 1] as any,
  });

  it('库内件全新实例 → 取固定真实色（全锁），不随 activeColorCode', async () => {
    // 71709 = Panel 3x7，全锁后固定为其真实最常见色 黑(0)；即便 active 画笔为红(4) 也应取 0。
    const source = makeMockPort('71709_new_instance', '71709');
    const target = makeMockPort('target.dat');

    await useStore.getState().snapParts(source, target);

    const newPart = useStore.getState().parts['71709_new_instance'];
    expect(newPart).toBeDefined();
    expect(newPart.colorCode).toBe(0);
  });

  it('库外件全新实例 → 回退继承当前 activeColorCode', async () => {
    // 不在生成表内的件（如自定义件）无固定色，降级到 active 画笔色，这里为 4。
    const source = makeMockPort('zzz_custom_new', 'zzz_custom_999');
    const target = makeMockPort('target.dat');

    await useStore.getState().snapParts(source, target);

    const newPart = useStore.getState().parts['zzz_custom_new'];
    expect(newPart).toBeDefined();
    expect(newPart.colorCode).toBe(4);
  });
});

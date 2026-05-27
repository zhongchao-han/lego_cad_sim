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

  it('全新零件实例的颜色应当继承当前的 activeColorCode', async () => {
    const source = makeMockPort('71709_new_instance', '71709'); // .dat will be stripped by getDefaultColorCode
    const target = makeMockPort('target.dat');

    // 吸附
    await useStore.getState().snapParts(source, target);

    const parts = useStore.getState().parts;
    const newPart = parts['71709_new_instance'];
    
    expect(newPart).toBeDefined();
    // 由于 71709 已经撤销了专属白名单，此时必然依靠 activeColorCode 降级，这里 active 为 4。
    // 旧版遗留代码会将其硬编码覆盖为 7，这一步测试我们已拆掉硬编码并正确传递了状态。
    expect(newPart.colorCode).toBe(4);
  });
});

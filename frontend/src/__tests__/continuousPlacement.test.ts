/**
 * continuousPlacement.test.ts
 * ============================
 * 回归测试：从预览面板选择零件后，连续点击多个目标端口应**累计**生成
 * 多根独立零件实例（俗称 Stamp 模式），而不是把同一根零件来回搬运。
 *
 * 历史 bug：handlePortClick 在调用 commitAxialSliding 之前就把 selectedPort
 * 从 store 解构为闭包常量；而 commitAxialSliding 在连续放置模式下会用新
 * instanceId 覆盖 selectedPort —— 后续 snapParts 仍引用旧 selectedPort，
 * 导致 parts[oldId] 被搬移到新孔位置，呈现"第一个孔的销移到第二个孔"。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { useStore } from '../store';
import { ZoneType, InteractionPhase } from '../types';

vi.mock('axios');
const mockAxios = vi.mocked(axios);

const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number[], number[], number[]];

function makePinSourcePort(partId: string) {
  return {
    partId,
    ldrawId: '2780.dat',
    portType: 'peg.dat',
    position:    [0, 0, 0] as [number, number, number],
    rotation:    EYE3,
    globalPos:   [0, 0, 0] as [number, number, number],
    globalQuat:  [0, 0, 0, 1] as [number, number, number, number],
    isFromPreview: true,
  };
}

function makeHolePort(partId: string, holeIdx: number, worldX: number) {
  return {
    partId,
    ldrawId: '71709.dat',
    portType: `peghole.${holeIdx}`,
    position:    [worldX, 0, 0] as [number, number, number],
    rotation:    EYE3,
    globalPos:   [worldX, 0, 0] as [number, number, number],
    globalQuat:  [0, 0, 0, 1] as [number, number, number, number],
  };
}

describe('continuous placement (stamp mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockAxios.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { status: 'success', auto_latched_count: 0 },
    });

    useStore.setState({
      parts: {
        'plate_1': {
          ldrawId: '71709.dat',
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          colorCode: 7,
          zone: ZoneType.ACTIVE_ARENA,
        },
      },
      connections: {},
      selectedPort: null,
      hoveredPort: null,
      slidingTarget: null,
      slideOffset: 0,
      snapPreState: null,
      continuousPlacementSource: null,
      interactionPhase: InteractionPhase.PREVIEWING,
      previewPartId: '2780.dat',
      logs: [],
    } as any);
  });

  it('从预览面板选销 → 点孔1 → 点孔2 → 点孔3，三个孔都应留下独立销', async () => {
    const store = useStore.getState();

    // step 1: 点击预览面板里的销端口 → SOURCE_LOCKED + 开启连续放置
    const pinPort = makePinSourcePort('2780.dat_initial');
    await store.handlePortClick(pinPort as any);
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.SOURCE_LOCKED);
    expect(useStore.getState().continuousPlacementSource).not.toBeNull();

    // step 2: 点击孔 1 → 创建第一根销，进入 AXIAL_SLIDING
    const hole1 = makeHolePort('plate_1', 0, 0.10);
    await useStore.getState().handlePortClick(hole1 as any);
    expect(useStore.getState().interactionPhase).toBe(InteractionPhase.AXIAL_SLIDING);
    const partsAfterHole1 = useStore.getState().parts;
    const pinIdsAfterHole1 = Object.keys(partsAfterHole1).filter(
      id => partsAfterHole1[id].ldrawId === '2780.dat'
    );
    expect(pinIdsAfterHole1.length).toBe(1);

    // step 3: 点击孔 2 → 应提交第一根 + 创建第二根
    const hole2 = makeHolePort('plate_1', 1, 0.20);
    await useStore.getState().handlePortClick(hole2 as any);
    const partsAfterHole2 = useStore.getState().parts;
    const pinIdsAfterHole2 = Object.keys(partsAfterHole2).filter(
      id => partsAfterHole2[id].ldrawId === '2780.dat'
    );
    expect(pinIdsAfterHole2.length).toBe(2);

    // 关键：第一根销不应被搬移，仍在 hole1 附近
    const firstPinId = pinIdsAfterHole1[0];
    expect(partsAfterHole2[firstPinId]).toBeDefined();
    expect(partsAfterHole2[firstPinId].position[0]).toBeCloseTo(0.10, 4);

    // step 4: 点击孔 3 → 应再多一根销，总计 3 根
    const hole3 = makeHolePort('plate_1', 2, 0.30);
    await useStore.getState().handlePortClick(hole3 as any);
    const partsAfterHole3 = useStore.getState().parts;
    const pinIdsAfterHole3 = Object.keys(partsAfterHole3).filter(
      id => partsAfterHole3[id].ldrawId === '2780.dat'
    );
    expect(pinIdsAfterHole3.length).toBe(3);

    // 三根销应分别在三个孔位置附近
    const pinXs = pinIdsAfterHole3.map(id => partsAfterHole3[id].position[0]).sort();
    expect(pinXs[0]).toBeCloseTo(0.10, 4);
    expect(pinXs[1]).toBeCloseTo(0.20, 4);
    expect(pinXs[2]).toBeCloseTo(0.30, 4);
  });
});

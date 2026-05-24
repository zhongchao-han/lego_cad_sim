import { describe, it, expect } from 'vitest';
import { findRelatchEdges, relatchPortIsFemale, type RelatchPartInput, type RelatchPortInput } from '../utils/relatchScan';

const EYE: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// 简化 portKey：position 拼字符串（测试里只需唯一 + 可解析）。
const portKeyFn = (pos: [number, number, number]) => pos.map((n) => n.toFixed(4)).join(',');

function pin(id: string, pos: [number, number, number]): RelatchPartInput {
  return { id, ldrawId: 'pin.dat', position: pos, quaternion: [0, 0, 0, 1] };
}
function board(id: string, pos: [number, number, number]): RelatchPartInput {
  return { id, ldrawId: 'board.dat', position: pos, quaternion: [0, 0, 0, 1] };
}

// pin: 一个 male 端口在原点；board: 一个 female 孔在原点。
const PORTS: Record<string, RelatchPortInput[]> = {
  'pin.dat': [{ position: [0, 0, 0], rotation: EYE, type: 'peg.dat' }],
  'board.dat': [{ position: [0, 0, 0], rotation: EYE, type: 'peghole.dat' }],
};

describe('relatchPortIsFemale', () => {
  it('gender 显式优先', () => {
    expect(relatchPortIsFemale({ position: [0, 0, 0], rotation: EYE, type: 'peg.dat', gender: 'FEMALE' })).toBe(true);
    expect(relatchPortIsFemale({ position: [0, 0, 0], rotation: EYE, type: 'peghole.dat', gender: 'MALE' })).toBe(false);
  });
  it('无 gender 按 type 含 hol 判母', () => {
    expect(relatchPortIsFemale({ position: [0, 0, 0], rotation: EYE, type: 'peghole.dat' })).toBe(true);
    expect(relatchPortIsFemale({ position: [0, 0, 0], rotation: EYE, type: 'peg.dat' })).toBe(false);
  });
});

describe('findRelatchEdges', () => {
  it('端口重合 + 极性互补 + 未连接 → 产生一条边', () => {
    const parts = [board('B', [0, 0, 0]), pin('P', [0, 0, 0])]; // 同位 → 端口重合
    const edges = findRelatchEdges(parts, PORTS, new Set(), portKeyFn, 0.001);
    expect(edges.length).toBe(1);
    expect([edges[0].a, edges[0].b].sort()).toEqual(['B', 'P']);
  });

  it('端口不重合（距离 > 阈值）→ 不产生边', () => {
    const parts = [board('B', [0, 0, 0]), pin('P', [0.05, 0, 0])]; // 50mm 远
    expect(findRelatchEdges(parts, PORTS, new Set(), portKeyFn, 0.001).length).toBe(0);
  });

  it('同极性（孔↔孔）即使重合也不连', () => {
    const parts = [board('B1', [0, 0, 0]), board('B2', [0, 0, 0])];
    expect(findRelatchEdges(parts, PORTS, new Set(), portKeyFn, 0.001).length).toBe(0);
  });

  it('已连接的件对被排除（幂等）', () => {
    const parts = [board('B', [0, 0, 0]), pin('P', [0, 0, 0])];
    const existing = new Set(['B|P']); // 已连
    expect(findRelatchEdges(parts, PORTS, existing, portKeyFn, 0.001).length).toBe(0);
  });

  it('世界坐标重合判定考虑零件位姿（板与销都平移到同处）', () => {
    const parts = [
      board('B', [0.1, 0, 0.2]),
      pin('P', [0.1, 0, 0.2]), // 同位姿 → 端口世界坐标重合
    ];
    expect(findRelatchEdges(parts, PORTS, new Set(), portKeyFn, 0.001).length).toBe(1);
  });

  it('一根销桥接两块板（销 male 端口分别与两板 female 孔重合）→ 两条边', () => {
    // 销有两个端口（两端），分别在 x=-0.01 和 x=+0.01；两板的孔分别在那两处。
    const ports: Record<string, RelatchPortInput[]> = {
      'pin2.dat': [
        { position: [-0.01, 0, 0], rotation: EYE, type: 'peg.dat' },
        { position: [0.01, 0, 0], rotation: EYE, type: 'peg.dat' },
      ],
      'board.dat': [{ position: [0, 0, 0], rotation: EYE, type: 'peghole.dat' }],
    };
    const parts: RelatchPartInput[] = [
      { id: 'PIN', ldrawId: 'pin2.dat', position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      { id: 'BL', ldrawId: 'board.dat', position: [-0.01, 0, 0], quaternion: [0, 0, 0, 1] },
      { id: 'BR', ldrawId: 'board.dat', position: [0.01, 0, 0], quaternion: [0, 0, 0, 1] },
    ];
    const edges = findRelatchEdges(parts, ports, new Set(), portKeyFn, 0.001);
    const pairs = edges.map((e) => [e.a, e.b].sort().join('|')).sort();
    expect(pairs).toEqual(['BL|PIN', 'BR|PIN']);
  });
});

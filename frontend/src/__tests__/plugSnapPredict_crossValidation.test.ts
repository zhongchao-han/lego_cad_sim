/**
 * plugSnapPredict_crossValidation.test.ts
 * =======================================
 * B.3-2 — 前端 predictPlugSnapPairs vs 后端 AutoLatchScanner 一致性验证。
 *
 * 跟 backend/tests/test_auto_latch_scanner.py::TestAutoLatchPlugScenarios
 * 镜像同样的几何场景。预期配对数必须一致 — 若前后端对配对结果不一致，
 * 任一侧改动会让另一侧的 case 红，强制同步两端语义（1mm 距离阈值 +
 * 极性 / profile 筛选）。
 *
 * Case 对照表（手动维护，CR 时跟后端 case 数字 1:1 看齐）：
 *   P1 8↔8 plate-on-plate  → 8 对
 *   P2 8↔4 asymmetric       → 4 对
 *   P3 主连接 exclude        → frontend 不模拟 exclude，跑全部 8 对
 *   P4 整体偏移 > 阈值       → 0 对
 */

import { describe, it, expect } from 'vitest';
import {
  predictPlugSnapPairs,
  AUTO_LATCH_DISTANCE_THRESHOLD,
  type PortWorldInfo,
} from '../utils/plugSnapPredict';
import type { Vec3 } from '../types';

function grid2x4(portType: string, offset: Vec3 = [0, 0, 0]): PortWorldInfo[] {
  // 2x4: x ∈ {0, 0.008}, z ∈ {0..0.024:0.008}
  const ports: PortWorldInfo[] = [];
  let idx = 0;
  for (let x = 0; x < 2; x++) {
    for (let z = 0; z < 4; z++) {
      ports.push({
        memberIdx: idx,
        worldPos: [x * 0.008 + offset[0], offset[1], z * 0.008 + offset[2]],
        portType,
      });
      idx++;
    }
  }
  return ports;
}

function grid1x4(portType: string, offset: Vec3 = [0, 0, 0]): PortWorldInfo[] {
  const ports: PortWorldInfo[] = [];
  for (let z = 0; z < 4; z++) {
    ports.push({
      memberIdx: z,
      worldPos: [offset[0], offset[1], z * 0.008 + offset[2]],
      portType,
    });
  }
  return ports;
}

describe('predictPlugSnapPairs — 跨语言 cross-validation 与后端 Auto-Latch', () => {
  it('P1: 8 stud (2x4 plate) ↔ 8 tube (2x4 plate) 完美对齐 → 8 对', () => {
    const src = grid2x4('stud');
    const tgt = grid2x4('tube');
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(8);
  });

  it('P2: 8 stud (2x4) ↔ 4 tube (1x4) 部分覆盖 → 4 对', () => {
    const src = grid2x4('stud');
    const tgt = grid1x4('tube');
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(4);
    // 4 个 tube 都在 x=0，所以应配到 source 中 x=0 那一列（前 4 个 memberIdx）
    const sourceIdxs = pairs.map(p => p.sourceMemberIdx).sort((a, b) => a - b);
    expect(sourceIdxs).toEqual([0, 1, 2, 3]);
  });

  it('P3: 8↔8 全配（前端无 exclude 概念，等同后端不传 exclude_port_pair）→ 8 对', () => {
    // 后端 P3 测的是 exclude main pair 后剩 7，这里前端 predict 不模拟 main
    // 概念，纯几何 + 语义筛选 → 8 对全配。callsite 拿到结果后自行从中
    // 减去 main pair（B.3-3 UX 显示时减一次）。
    const src = grid2x4('stud');
    const tgt = grid2x4('tube');
    expect(predictPlugSnapPairs(src, tgt)).toHaveLength(8);
  });

  it('P4: 整体偏移 5mm > 1mm 阈值 → 0 对', () => {
    const src = grid2x4('stud');
    const tgt = grid2x4('tube', [0.005, 0, 0]);  // 整体偏移
    expect(predictPlugSnapPairs(src, tgt)).toEqual([]);
  });

  it('阈值常量同源 — AUTO_LATCH_DISTANCE_THRESHOLD == backend AUTO_LATCH_THRESHOLD_M (1mm)', () => {
    expect(AUTO_LATCH_DISTANCE_THRESHOLD).toBe(0.001);
  });
});

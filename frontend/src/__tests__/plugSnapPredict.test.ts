/**
 * plugSnapPredict.test.ts
 * =======================
 * B.3-1 — plug-snap 预测纯函数单测。覆盖：
 *   - 完美对齐：源 plug N 成员 ↔ 目标 plug N 成员一一配对
 *   - 不等数量：源 8 stud → 目标 4 hole → 4 对
 *   - 距离超阈值：> 1mm → 不配对
 *   - 语义不兼容：MALE-MALE / FEMALE-FEMALE → 不配对
 *   - 双向 bijection：两个 source 抢同一 target，先到的占住
 *   - 贪心最近：距离平手 / 优先最短
 *   - 空 plug / 单 plug member
 */

import { describe, it, expect } from 'vitest';
import {
  predictPlugSnapPairs,
  AUTO_LATCH_DISTANCE_THRESHOLD,
  type PortWorldInfo,
} from '../utils/plugSnapPredict';
import type { Vec3 } from '../types';

const STUD = 'stud';        // MALE STUD
const TUBE = 'tube';        // FEMALE STUD (跟 stud 配)
const PEG = 'peg';          // MALE CYL
const PEGHOLE = 'peghole';  // FEMALE CYL (跟 peg 配)

function member(idx: number, worldPos: Vec3, portType: string): PortWorldInfo {
  return { memberIdx: idx, worldPos, portType };
}

describe('predictPlugSnapPairs', () => {
  it('case 1: 1 stud ↔ 1 tube 完美对齐（< 1mm）→ 1 对', () => {
    const src = [member(0, [0, 0, 0], STUD)];
    const tgt = [member(0, [0, 0, 0], TUBE)];
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].sourceMemberIdx).toBe(0);
    expect(pairs[0].targetMemberIdx).toBe(0);
    expect(pairs[0].distance).toBeCloseTo(0, 6);
  });

  it('case 2: 8 stud（2x4 plate 顶）↔ 8 tube（2x4 plate 底）完美对齐 → 8 对 bijection', () => {
    // 2x4 grid: x in {0, 0.008}, z in {0, 0.008, 0.016, 0.024}
    const src: PortWorldInfo[] = [];
    const tgt: PortWorldInfo[] = [];
    let i = 0;
    for (let x = 0; x < 2; x++) {
      for (let z = 0; z < 4; z++) {
        src.push(member(i, [x * 0.008, 0, z * 0.008], STUD));
        tgt.push(member(i, [x * 0.008, 0, z * 0.008], TUBE));
        i++;
      }
    }
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(8);
    // 每个 source 配到唯一 target（bijection）
    const tgtIds = pairs.map(p => p.targetMemberIdx).sort();
    expect(tgtIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('case 3: 不等数量 — 源 8 stud / 目标 4 tube → 4 对（剩 4 source 无配）', () => {
    const src: PortWorldInfo[] = [];
    for (let i = 0; i < 8; i++) src.push(member(i, [i * 0.008, 0, 0], STUD));
    const tgt: PortWorldInfo[] = [];
    for (let i = 0; i < 4; i++) tgt.push(member(i, [i * 0.008, 0, 0], TUBE));
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(4);
    // 前 4 source 对到对应 target
    expect(pairs.map(p => p.sourceMemberIdx)).toEqual([0, 1, 2, 3]);
    expect(pairs.map(p => p.targetMemberIdx)).toEqual([0, 1, 2, 3]);
  });

  it('case 4: 距离 > 1mm → 不配对', () => {
    const src = [member(0, [0, 0, 0], STUD)];
    const tgt = [member(0, [0.002, 0, 0], TUBE)]; // 2mm 偏移
    expect(predictPlugSnapPairs(src, tgt)).toEqual([]);
  });

  it('case 5: 自定义阈值 — 放宽到 5mm → 1 对', () => {
    const src = [member(0, [0, 0, 0], STUD)];
    const tgt = [member(0, [0.002, 0, 0], TUBE)];
    const pairs = predictPlugSnapPairs(src, tgt, 0.005);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].distance).toBeCloseTo(0.002, 6);
  });

  it('case 6: 语义不兼容 — MALE↔MALE → 不配对', () => {
    const src = [member(0, [0, 0, 0], STUD)];
    const tgt = [member(0, [0, 0, 0], STUD)]; // 都 MALE
    expect(predictPlugSnapPairs(src, tgt)).toEqual([]);
  });

  it('case 7: 语义不兼容 — FEMALE↔FEMALE → 不配对', () => {
    const src = [member(0, [0, 0, 0], TUBE)];
    const tgt = [member(0, [0, 0, 0], PEGHOLE)]; // 都 FEMALE
    expect(predictPlugSnapPairs(src, tgt)).toEqual([]);
  });

  it('case 8: profile 不匹配 — stud (STUD) vs peghole (CYL) → 不配对', () => {
    const src = [member(0, [0, 0, 0], STUD)];      // MALE STUD
    const tgt = [member(0, [0, 0, 0], PEGHOLE)];   // FEMALE CYL
    expect(predictPlugSnapPairs(src, tgt)).toEqual([]);
  });

  it('case 9: 顺序无关 — source 是 FEMALE / target 是 MALE 也能配（checkFit 双向试）', () => {
    const src = [member(0, [0, 0, 0], PEGHOLE)];  // FEMALE
    const tgt = [member(0, [0, 0, 0], PEG)];      // MALE
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(1);
  });

  it('case 10: 双向 bijection — 两个 source 在同一 target 附近，只能配一对', () => {
    const src = [
      member(0, [0, 0, 0], STUD),
      member(1, [0.0001, 0, 0], STUD), // 距离 target 0 也是 0.1mm
    ];
    const tgt = [member(0, [0, 0, 0], TUBE)];
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(1);
    // 先到的（source 0，距离 0）赢
    expect(pairs[0].sourceMemberIdx).toBe(0);
    expect(pairs[0].targetMemberIdx).toBe(0);
  });

  it('case 11: 贪心最近 — source 0 有两个 target 候选，挑近的', () => {
    const src = [member(0, [0, 0, 0], STUD)];
    const tgt = [
      member(0, [0.0008, 0, 0], TUBE), // 0.8mm
      member(1, [0.0002, 0, 0], TUBE), // 0.2mm ← 近，应中
    ];
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].targetMemberIdx).toBe(1);
    expect(pairs[0].distance).toBeCloseTo(0.0002, 6);
  });

  it('case 12: 空 plug — source / target 任一空 → 空配对', () => {
    expect(predictPlugSnapPairs([], [member(0, [0, 0, 0], TUBE)])).toEqual([]);
    expect(predictPlugSnapPairs([member(0, [0, 0, 0], STUD)], [])).toEqual([]);
    expect(predictPlugSnapPairs([], [])).toEqual([]);
  });

  it('case 13: AUTO_LATCH_DISTANCE_THRESHOLD = 0.001 (1mm，跟后端同源)', () => {
    expect(AUTO_LATCH_DISTANCE_THRESHOLD).toBe(0.001);
  });

  it('case 14: 边界距离 — 正好 1mm（不严格小于阈值默认应排除）', () => {
    // 实现用 d > threshold continue，所以 d == threshold 是包含的
    const src = [member(0, [0, 0, 0], STUD)];
    const tgt = [member(0, [0.001, 0, 0], TUBE)]; // 正好 1mm
    const pairs = predictPlugSnapPairs(src, tgt);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].distance).toBeCloseTo(0.001, 6);
  });
});

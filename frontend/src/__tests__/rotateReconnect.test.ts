/**
 * rotateReconnect.test.ts
 * =======================
 * Feature A 纯几何单测：单件旋转后重连/脱开决策。
 */

import { describe, it, expect } from 'vitest';
import {
  parsePortKeyPos,
  portWorldPos,
  rotatePartAboutPivot,
  worldPivot,
  evaluateRotateReconnect,
  pickBasePart,
  type RigidPose,
  type Vec3,
} from '../utils/rotateReconnect';

const ID: RigidPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
const HALF_PI = Math.PI / 2;

// 序列化端口 key（只用位置部分，方向可选）
const key = (p: Vec3) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;

describe('parsePortKeyPos', () => {
  it('解析 "x,y,z"', () => {
    expect(parsePortKeyPos('1.2000,3.4000,5.6000')).toEqual([1.2, 3.4, 5.6]);
  });
  it('解析带方向后缀 "x,y,z|zx,zy,zz"', () => {
    expect(parsePortKeyPos('0.0000,0.0040,0.0000|0.00,1.00,0.00')).toEqual([0, 0.004, 0]);
  });
  it('非法 → null', () => {
    expect(parsePortKeyPos('garbage')).toBeNull();
    expect(parsePortKeyPos('1,2')).toBeNull();
  });
});

describe('portWorldPos', () => {
  it('单位位姿 → world = local', () => {
    expect(portWorldPos(ID, [1, 2, 3])).toEqual([1, 2, 3]);
  });
  it('带平移', () => {
    const pose: RigidPose = { position: [10, 0, 0], quaternion: [0, 0, 0, 1] };
    expect(portWorldPos(pose, [1, 0, 0])).toEqual([11, 0, 0]);
  });
});

describe('rotatePartAboutPivot', () => {
  it('绕原点 Y 转 90°：位置不变（在 pivot 上），朝向改变', () => {
    const r = rotatePartAboutPivot(ID, [0, 0, 0], [0, 1, 0], HALF_PI);
    expect(r.position[0]).toBeCloseTo(0, 6);
    expect(r.position[2]).toBeCloseTo(0, 6);
    // quat 不再是单位
    expect(Math.abs(r.quaternion[1])).toBeGreaterThan(0.1);
  });

  it('绕偏移 pivot 公转：(d,0,0) 绕原点 Y 转 90° → (0,0,-d)', () => {
    const pose: RigidPose = { position: [0.02, 0, 0], quaternion: [0, 0, 0, 1] };
    const r = rotatePartAboutPivot(pose, [0, 0, 0], [0, 1, 0], HALF_PI);
    expect(r.position[0]).toBeCloseTo(0, 6);
    expect(r.position[1]).toBeCloseTo(0, 6);
    expect(r.position[2]).toBeCloseTo(-0.02, 6);
  });
});

describe('worldPivot', () => {
  it('无 bboxCenter → 用零件原点', () => {
    const pose: RigidPose = { position: [5, 6, 7], quaternion: [0, 0, 0, 1] };
    expect(worldPivot(pose, null)).toEqual([5, 6, 7]);
  });
  it('有 bboxCenter（单位姿）→ 原点 + 偏移', () => {
    const pose: RigidPose = { position: [5, 0, 0], quaternion: [0, 0, 0, 1] };
    expect(worldPivot(pose, [0, 0.004, 0])).toEqual([5, 0.004, 0]);
  });
});

describe('evaluateRotateReconnect — moving↔base 界面重连/脱开', () => {
  const A = 0.008; // 8mm
  const ROT90 = rotatePartAboutPivot(ID, [0, 0, 0], [0, 1, 0], HALF_PI); // 选中件绕原点转 90°

  it('对称方阵端口：转 90° 端口映射回自身 → 界面边保持，无需微移', () => {
    const square: Vec3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    const occP: Record<string, string> = {}; square.forEach(p => { occP[key(p)] = 'B'; });
    const occB: Record<string, string> = {}; square.forEach(p => { occB[key(p)] = 'P'; });

    const r = evaluateRotateReconnect({
      movingNewPoses: { P: ROT90 },
      movingOccupied: { P: occP },
      basePoses: { B: ID },
      baseOccupied: { B: occB },
    });

    expect(r.keptEdges).toEqual([['P', 'B']]);
    expect(r.detachedEdges).toEqual([]);
    expect(r.autoMove[0]).toBeCloseTo(0, 6);
    expect(r.autoMove[2]).toBeCloseTo(0, 6);
  });

  it('沿 X 双点：转 90° 变沿 Z，微移无法复原 → 界面边脱开', () => {
    const line: Vec3[] = [[A, 0, 0], [-A, 0, 0]];
    const occP: Record<string, string> = {}; line.forEach(p => { occP[key(p)] = 'B'; });
    const occB: Record<string, string> = {}; line.forEach(p => { occB[key(p)] = 'P'; });

    const r = evaluateRotateReconnect({
      movingNewPoses: { P: ROT90 },
      movingOccupied: { P: occP },
      basePoses: { B: ID },
      baseOccupied: { B: occB },
    });

    expect(r.keptEdges).toEqual([]);
    expect(r.detachedEdges).toEqual([['P', 'B']]);
  });

  it('整组平移错位 D → 自动微移复原 → 保持 + 非零 autoMove', () => {
    const D = 0.02;
    const square: Vec3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    // moving 件 P 平移到 (D,0,D)（无旋转），端口世界 = square + (D,0,D)
    const movedPose: RigidPose = { position: [D, 0, D], quaternion: [0, 0, 0, 1] };
    const occP: Record<string, string> = {}; square.forEach(p => { occP[key(p)] = 'B'; });
    // base B 端口在原 square 位置
    const occB: Record<string, string> = {}; square.forEach(p => { occB[key(p)] = 'P'; });

    const r = evaluateRotateReconnect({
      movingNewPoses: { P: movedPose },
      movingOccupied: { P: occP },
      basePoses: { B: ID },
      baseOccupied: { B: occB },
    });

    expect(r.keptEdges).toEqual([['P', 'B']]);
    expect(r.autoMove[0]).toBeCloseTo(-D, 6);
    expect(r.autoMove[2]).toBeCloseTo(-D, 6);
  });

  it('多界面边：对称方阵边保持，沿 X 双点边脱开', () => {
    const square: Vec3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    const line: Vec3[] = [[A, 0, 0], [-A, 0, 0]];
    const occP: Record<string, string> = {};
    square.forEach(p => { occP[key(p)] = 'Bsq'; });
    line.forEach(p => { occP[key(p)] = 'Bln'; });
    const occBsq: Record<string, string> = {}; square.forEach(p => { occBsq[key(p)] = 'P'; });
    const occBln: Record<string, string> = {}; line.forEach(p => { occBln[key(p)] = 'P'; });

    const r = evaluateRotateReconnect({
      movingNewPoses: { P: ROT90 },
      movingOccupied: { P: occP },
      basePoses: { Bsq: ID, Bln: ID },
      baseOccupied: { Bsq: occBsq, Bln: occBln },
    });

    expect(r.keptEdges).toEqual([['P', 'Bsq']]);
    expect(r.detachedEdges).toEqual([['P', 'Bln']]);
  });

  it('内部 moving↔moving 连接（插销↔板）不参与界面评估', () => {
    const square: Vec3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    // P 同时连 base B（方阵，保持）和 moving 组内的 pin（内部，应忽略）
    const occP: Record<string, string> = {};
    square.forEach(p => { occP[key(p)] = 'B'; });
    occP[key([0, A, 0])] = 'pin';  // 指向 moving 组内零件
    const occPin: Record<string, string> = { [key([0, A, 0])]: 'P' };
    const occB: Record<string, string> = {}; square.forEach(p => { occB[key(p)] = 'P'; });

    const r = evaluateRotateReconnect({
      movingNewPoses: { P: ROT90, pin: ROT90 },
      movingOccupied: { P: occP, pin: occPin },
      basePoses: { B: ID },
      baseOccupied: { B: occB },
    });

    // 只有 P↔B 被评估；P↔pin（内部）永不出现在结果里
    const allEdges = [...r.keptEdges, ...r.detachedEdges];
    expect(allEdges).toEqual([['P', 'B']]);
    expect(allEdges.some(([, peer]) => peer === 'pin')).toBe(false);
  });

  it('autoMove=false（平移语义）：错位 D 不吸回 → autoMove 0 且界面脱开', () => {
    const square: Vec3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    const movedPose: RigidPose = { position: [0.02, 0, 0.02], quaternion: [0, 0, 0, 1] };
    const occP: Record<string, string> = {}; square.forEach(p => { occP[key(p)] = 'B'; });
    const occB: Record<string, string> = {}; square.forEach(p => { occB[key(p)] = 'P'; });

    const r = evaluateRotateReconnect({
      movingNewPoses: { P: movedPose },
      movingOccupied: { P: occP },
      basePoses: { B: ID },
      baseOccupied: { B: occB },
      autoMove: false,
    });

    // 平移不吸回：autoMove 必须为 0，且因错位而脱开（不强行拉回保持连接）
    expect(r.autoMove).toEqual([0, 0, 0]);
    expect(r.detachedEdges).toEqual([['P', 'B']]);
    expect(r.keptEdges).toEqual([]);
  });

  it('无界面边（孤立 / 全内部）→ autoMove 0，无 kept/detached', () => {
    const r = evaluateRotateReconnect({
      movingNewPoses: { P: ROT90 },
      movingOccupied: {},
      basePoses: {},
      baseOccupied: {},
    });
    expect(r.keptEdges).toEqual([]);
    expect(r.detachedEdges).toEqual([]);
    expect(r.autoMove).toEqual([0, 0, 0]);
  });
});

describe('pickBasePart — 连通组里挑最大件作地基', () => {
  const sizeMap = (m: Record<string, Vec3 | null>) => (id: string) => m[id] ?? null;

  it('包围盒体积最大者胜出（大底板 ≫ 小件）', () => {
    const size = sizeMap({ base: [0.3, 0.01, 0.2], plate: [0.03, 0.01, 0.01], pin: [0.002, 0.02, 0.002] });
    expect(pickBasePart(['plate', 'base', 'pin'], size)).toBe('base');
  });

  it('size 缺失记 0；有 size 者优先', () => {
    const size = sizeMap({ a: null, b: [0.01, 0.01, 0.01] });
    expect(pickBasePart(['a', 'b'], size)).toBe('b');
  });

  it('体积相同 → 稳定取 id 较小者', () => {
    const size = sizeMap({ z: [0.01, 0.01, 0.01], a: [0.01, 0.01, 0.01] });
    expect(pickBasePart(['z', 'a'], size)).toBe('a');
  });

  it('空组 → null', () => {
    expect(pickBasePart([], () => null)).toBeNull();
  });
});

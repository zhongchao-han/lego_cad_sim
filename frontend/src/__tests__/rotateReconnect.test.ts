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

describe('evaluateRotateReconnect', () => {
  const A = 0.008; // 8mm

  it('对称方阵端口绕中心转 90° → 端口映射回自身，连接保持，无需微移', () => {
    const square: Vec3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    const occA: Record<string, string> = {};
    square.forEach(p => { occA[key(p)] = 'peer'; });
    const occPeer: Record<string, string> = {};
    square.forEach(p => { occPeer[key(p)] = 'partP'; });

    const r = evaluateRotateReconnect({
      oldPose: ID, pivot: [0, 0, 0], axis: [0, 1, 0], angle: HALF_PI,
      partId: 'partP',
      occupiedByPart: occA,
      peerPoses: { peer: ID },
      peerOccupied: { peer: occPeer },
    });

    expect(r.keptPeers).toEqual(['peer']);
    expect(r.detachedPeers).toEqual([]);
    expect(r.autoMove[0]).toBeCloseTo(0, 6);
    expect(r.autoMove[1]).toBeCloseTo(0, 6);
    expect(r.autoMove[2]).toBeCloseTo(0, 6);
  });

  it('沿 X 的两点连接绕中心转 90° → 变沿 Z，平移无法复原 → 脱开', () => {
    const line: Vec3[] = [[A, 0, 0], [-A, 0, 0]];
    const occA: Record<string, string> = {};
    line.forEach(p => { occA[key(p)] = 'peer'; });
    const occPeer: Record<string, string> = {};
    line.forEach(p => { occPeer[key(p)] = 'partP'; });

    const r = evaluateRotateReconnect({
      oldPose: ID, pivot: [0, 0, 0], axis: [0, 1, 0], angle: HALF_PI,
      partId: 'partP',
      occupiedByPart: occA,
      peerPoses: { peer: ID },
      peerOccupied: { peer: occPeer },
    });

    expect(r.keptPeers).toEqual([]);
    expect(r.detachedPeers).toEqual(['peer']);
  });

  it('绕偏移 pivot 转后整体错位，自动微移可复原 → 保持 + 非零 autoMove', () => {
    const D = 0.02;
    const square: Vec3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    // P 在 (D,0,0)，端口世界坐标 = (D±A, 0, ±A)
    const partPose: RigidPose = { position: [D, 0, 0], quaternion: [0, 0, 0, 1] };
    const occA: Record<string, string> = {};
    square.forEach(p => { occA[key(p)] = 'peer'; });
    // peer 端口世界坐标须 = P 旋转前的世界端口（连接初始重合）
    const occPeer: Record<string, string> = {};
    square.forEach(p => { occPeer[key([p[0] + D, p[1], p[2]])] = 'partP'; });

    const r = evaluateRotateReconnect({
      oldPose: partPose, pivot: [0, 0, 0], axis: [0, 1, 0], angle: HALF_PI,
      partId: 'partP',
      occupiedByPart: occA,
      peerPoses: { peer: ID },
      peerOccupied: { peer: occPeer },
    });

    expect(r.keptPeers).toEqual(['peer']);
    expect(r.autoMove[0]).toBeCloseTo(D, 6);
    expect(r.autoMove[2]).toBeCloseTo(D, 6);
  });

  it('多 peer：对称方阵 peer 保持，沿 X 双点 peer 脱开', () => {
    const square: Vec3[] = [[A, 0, A], [A, 0, -A], [-A, 0, A], [-A, 0, -A]];
    const line: Vec3[] = [[A, 0, 0], [-A, 0, 0]];
    const occA: Record<string, string> = {};
    square.forEach(p => { occA[key(p)] = 'peerSquare'; });
    line.forEach(p => { occA[key(p)] = 'peerLine'; });
    const occSquare: Record<string, string> = {};
    square.forEach(p => { occSquare[key(p)] = 'partP'; });
    const occLine: Record<string, string> = {};
    line.forEach(p => { occLine[key(p)] = 'partP'; });

    const r = evaluateRotateReconnect({
      oldPose: ID, pivot: [0, 0, 0], axis: [0, 1, 0], angle: HALF_PI,
      partId: 'partP',
      occupiedByPart: occA,
      peerPoses: { peerSquare: ID, peerLine: ID },
      peerOccupied: { peerSquare: occSquare, peerLine: occLine },
    });

    expect(r.keptPeers).toEqual(['peerSquare']);
    expect(r.detachedPeers).toEqual(['peerLine']);
  });

  it('无任何连接（孤立件）→ 仅旋转，无 peer', () => {
    const r = evaluateRotateReconnect({
      oldPose: ID, pivot: [0, 0, 0], axis: [0, 1, 0], angle: HALF_PI,
      partId: 'partP',
      occupiedByPart: {},
      peerPoses: {},
      peerOccupied: {},
    });
    expect(r.keptPeers).toEqual([]);
    expect(r.detachedPeers).toEqual([]);
    expect(r.autoMove).toEqual([0, 0, 0]);
  });
});

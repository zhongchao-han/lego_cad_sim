/**
 * snapMath.test.ts
 * =================
 * 验证 store.ts snapParts 中插入轴提取逻辑的正确性（Z 轴规范）。
 *
 * 核心问题（来自 docs/issue/pin_clipping_issue.md）：
 *   baseAxis 必须是 [0, 0, 1]（Z 轴），而非 [0, 1, 0]（Y 轴）。
 *   mat3MulVec3(rotation, [0, 0, 1]) 提取旋转矩阵 Z 列 = 端口插入轴。
 *
 * 旋转矩阵约定（来自 port.py / Port.to_dict()，2D 行优先数组）：
 *   pin.dat  (MALE)  → Rx(+90°): [[1,0,0],[0,0,-1],[0,1,0]]，Z 列 = [0,-1,0]
 *   peghole  (FEMALE)→ Rx(-90°): [[1,0,0],[0,0,1],[0,-1,0]]，Z 列 = [0, 1,0]
 */
import { describe, it, expect } from 'vitest';
import {
  calculateClampedOffset,
  calculateSnapPose,
  applyGroupDelta,
  calculatePortRotationPose,
  type RigidPose,
} from '../utils/snapMath';

// ---------------------------------------------------------------------------
// 复制 store.ts 中的纯数学工具（与源文件保持完全一致，用于隔离测试）
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];
type Mat3 = number[][] | number[];

const mat3MulVec3 = (m: Mat3, v: Vec3): Vec3 => {
  if (Array.isArray(m[0])) {
    const mm = m as number[][];
    return [
      mm[0][0] * v[0] + mm[0][1] * v[1] + mm[0][2] * v[2],
      mm[1][0] * v[0] + mm[1][1] * v[1] + mm[1][2] * v[2],
      mm[2][0] * v[0] + mm[2][1] * v[1] + mm[2][2] * v[2],
    ];
  }
  const flat = m as number[];
  return [
    flat[0] * v[0] + flat[1] * v[1] + flat[2] * v[2],
    flat[3] * v[0] + flat[4] * v[1] + flat[5] * v[2],
    flat[6] * v[0] + flat[7] * v[1] + flat[8] * v[2],
  ];
};

// ---------------------------------------------------------------------------
// 旋转矩阵常量（来自 port.py 归一化结果）
// ---------------------------------------------------------------------------

// Rx(+90°)：pin.dat (MALE) 归一化旋转矩阵
//   Z 列（插入轴）= [0, -1, 0]（销突出方向 = -Y）
const PIN_ROT_2D: Mat3 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
const PIN_ROT_FLAT: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];

// Rx(-90°)：peghole.dat (FEMALE) 归一化旋转矩阵
//   Z 列（插入轴）= [0, 1, 0]（孔开口方向 = +Y）
const HOLE_ROT_2D: Mat3 = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];

const CORRECT_BASE_AXIS: Vec3 = [0, 0, 1];  // 修复后（Z 轴）
const BUGGY_BASE_AXIS: Vec3 = [0, 1, 0];    // bug 版（Y 轴）

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

describe('snapParts: baseAxis Z-axis convention', () => {

  describe('Z-axis (fixed) correctly extracts insertion axis', () => {
    it('pin.dat: mat3MulVec3(pinRot, [0,0,1]) == [0, -1, 0]', () => {
      const axis = mat3MulVec3(PIN_ROT_2D, CORRECT_BASE_AXIS);
      expect(axis[0]).toBeCloseTo(0);
      expect(axis[1]).toBeCloseTo(-1);
      expect(axis[2]).toBeCloseTo(0);
    });

    it('peghole: mat3MulVec3(holeRot, [0,0,1]) == [0, 1, 0]', () => {
      const axis = mat3MulVec3(HOLE_ROT_2D, CORRECT_BASE_AXIS);
      expect(axis[0]).toBeCloseTo(0);
      expect(axis[1]).toBeCloseTo(1);
      expect(axis[2]).toBeCloseTo(0);
    });

    it('pin and hole insertion axes are antiparallel (connection condition)', () => {
      const pinAxis  = mat3MulVec3(PIN_ROT_2D,  CORRECT_BASE_AXIS);
      const holeAxis = mat3MulVec3(HOLE_ROT_2D, CORRECT_BASE_AXIS);
      expect(pinAxis[0] + holeAxis[0]).toBeCloseTo(0);
      expect(pinAxis[1] + holeAxis[1]).toBeCloseTo(0);
      expect(pinAxis[2] + holeAxis[2]).toBeCloseTo(0);
    });

    it('identity rotation returns pure Z direction', () => {
      const identity: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const axis = mat3MulVec3(identity, CORRECT_BASE_AXIS);
      expect(axis[0]).toBeCloseTo(0);
      expect(axis[1]).toBeCloseTo(0);
      expect(axis[2]).toBeCloseTo(1);
    });

    it('flat and 2D row-major representations give identical results', () => {
      const axis2D   = mat3MulVec3(PIN_ROT_2D,   CORRECT_BASE_AXIS);
      const axisFlat = mat3MulVec3(PIN_ROT_FLAT, CORRECT_BASE_AXIS);
      expect(axis2D[0]).toBeCloseTo(axisFlat[0]);
      expect(axis2D[1]).toBeCloseTo(axisFlat[1]);
      expect(axis2D[2]).toBeCloseTo(axisFlat[2]);
    });
  });

  describe('Y-axis (buggy) extracts wrong column', () => {
    it('pin.dat: mat3MulVec3(pinRot, [0,1,0]) gives [0, 0, 1] (Z direction, NOT insertion axis)', () => {
      const wrongAxis = mat3MulVec3(PIN_ROT_2D, BUGGY_BASE_AXIS);
      // Y 列 of Rx(+90°) = [0, 0, 1]（侧向，不是插入轴）
      expect(wrongAxis[0]).toBeCloseTo(0);
      expect(wrongAxis[1]).toBeCloseTo(0);
      expect(wrongAxis[2]).toBeCloseTo(1);
    });

    it('buggy Y-axis result differs from correct Z-axis result for pin', () => {
      const correctAxis = mat3MulVec3(PIN_ROT_2D, CORRECT_BASE_AXIS);
      const buggyAxis   = mat3MulVec3(PIN_ROT_2D, BUGGY_BASE_AXIS);
      const same = correctAxis.every((v, i) => Math.abs(v - buggyAxis[i]) < 1e-9);
      expect(same).toBe(false);
    });

    it('buggy Y-axis gives antiparallel axes in wrong Z direction instead of correct Y direction', () => {
      const pinAxis  = mat3MulVec3(PIN_ROT_2D,  BUGGY_BASE_AXIS);
      const holeAxis = mat3MulVec3(HOLE_ROT_2D, BUGGY_BASE_AXIS);
      // Bug: axes are [0,0,1] and [0,0,-1] — antiparallel but along Z (wrong axis for snapping)
      expect(pinAxis[2]).toBeCloseTo(1);    // along +Z, not along insertion axis
      expect(holeAxis[2]).toBeCloseTo(-1);  // along -Z
      // Correct axes should be along Y ([0,-1,0] and [0,1,0]), not Z
      expect(Math.abs(pinAxis[1])).toBeCloseTo(0);   // no Y component — wrong
      expect(Math.abs(holeAxis[1])).toBeCloseTo(0);  // no Y component — wrong
    });
  });
});

describe('calculateClampedOffset (TS-6.3 狂暴穿模验证)', () => {
  it('TS-6.3-A: 没有 shiftKey 时，超出限位会被 clamp', () => {
    // 假设限制 8，传入 15，应当被卡在 8
    const offset = calculateClampedOffset(15, false, 8);
    expect(offset).toBe(8);

    // 假设限制 8，传入 -15，应当被卡在 -8
    const offsetNeg = calculateClampedOffset(-15, false, 8);
    expect(offsetNeg).toBe(-8);
  });

  it('TS-6.3-B: 携带 shiftKey=true 时，无视 clamp 限制实现穿模', () => {
    // 假设限制 8，传入 25，因为按了 shift，直接返回 25
    const offset = calculateClampedOffset(25, true, 8);
    expect(offset).toBe(25);

    const offsetNeg = calculateClampedOffset(-100, true, 8);
    expect(offsetNeg).toBe(-100);
  });

  it('TS-6.3-C: 没有 shiftKey 但未超出限位时，正常返回', () => {
    const offset = calculateClampedOffset(5, false, 8);
    expect(offset).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// L54 对象池正确性回归
// ---------------------------------------------------------------------------
// 三个 export 函数都用模块级 scratch（_csp_*/_agd_*/_prp_*）。重构前每次 new
// 一堆 Three 对象；重构后必须保证：
//   1. 单次输出与重构前等价
//   2. 同函数连续调用 / 不同函数交叉调用 不互相污染（scratch reuse 安全）
// ---------------------------------------------------------------------------

const expectVecClose = (a: number[], b: number[], precision = 6) => {
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], precision);
};

describe('calculateSnapPose: 几何正确性 + scratch reuse 安全', () => {
  it('Identity in identity out：source=target 都在原点 → part 落原点（带 X-flip）', () => {
    const pose = calculateSnapPose([0, 0, 0], [0, 0, 0, 1], [0, 0, 0], [0, 0, 0, 1]);
    expectVecClose(pose.position, [0, 0, 0]);
    // X-flip 是 Rx(π)，对应 quaternion = (1, 0, 0, 0)（实部 0）
    expectVecClose(pose.quaternion, [1, 0, 0, 0]);
  });

  it('target 平移 → part 跟着平移到 target', () => {
    const pose = calculateSnapPose([0, 0, 0], [0, 0, 0, 1], [1, 2, 3], [0, 0, 0, 1]);
    expectVecClose(pose.position, [1, 2, 3]);
  });

  it('source 在零件局部 +Z 方向偏 0.5 → part 必须往后退 0.5（让 source 落到 target）', () => {
    // source 在 part 局部坐标 +Z=0.5；要把 source 对齐到原点 target（带 flip 后 source 朝 -Z）
    // flip 后 source 的局部 Z 反向；为了 source 落到 (0,0,0)，part 必须沿 +Z 平移 0.5
    const pose = calculateSnapPose([0, 0, 0.5], [0, 0, 0, 1], [0, 0, 0], [0, 0, 0, 1]);
    // X-flip 反转 Y 与 Z，所以 source 的 Z=0.5 → 在 part 局部成 Z=-0.5；为对齐到原点 target，
    // part.position.z 必须 = +0.5
    expect(pose.position[2]).toBeCloseTo(0.5);
  });

  it('连续 1000 次调用结果完全稳定（scratch 不被污染）', () => {
    const first = calculateSnapPose([0.01, 0.02, 0.03], [0, 0, 0, 1], [0.5, 0.6, 0.7], [0, 0, 0, 1]);
    for (let i = 0; i < 999; i++) {
      // 在两次相同输入之间穿插不同输入，验证 scratch 不会"卡住"在中间状态
      calculateSnapPose([0.9, -0.5, 0.1], [0, 0.7071, 0, 0.7071], [-0.3, 0.4, 0.8], [0.7071, 0, 0, 0.7071]);
    }
    const last = calculateSnapPose([0.01, 0.02, 0.03], [0, 0, 0, 1], [0.5, 0.6, 0.7], [0, 0, 0, 1]);
    expectVecClose(first.position, last.position, 8);
    expectVecClose(first.quaternion, last.quaternion, 8);
  });

  it('返回值是 plain number 数组而非 THREE 对象引用（防 scratch 泄漏）', () => {
    const pose = calculateSnapPose([0, 0, 0], [0, 0, 0, 1], [1, 0, 0], [0, 0, 0, 1]);
    expect(Array.isArray(pose.position)).toBe(true);
    expect(pose.position.length).toBe(3);
    expect(typeof pose.position[0]).toBe('number');
    expect(Array.isArray(pose.quaternion)).toBe(true);
    expect(pose.quaternion.length).toBe(4);
  });
});

describe('applyGroupDelta: 刚体 delta 整组应用', () => {
  it('source 自身用 newSource 直接覆盖（不走 delta 通道）', () => {
    const old: RigidPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    const newP: RigidPose = { position: [5, 6, 7], quaternion: [0, 0, 0, 1] };
    const out = applyGroupDelta(['src'], { src: old }, 'src', old, newP);
    expect(out.src).toBe(newP);
  });

  it('source 平移 [10,0,0] → 组员同步平移 [10,0,0]', () => {
    const oldSrc: RigidPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    const newSrc: RigidPose = { position: [10, 0, 0], quaternion: [0, 0, 0, 1] };
    const member: RigidPose = { position: [1, 2, 3], quaternion: [0, 0, 0, 1] };
    const out = applyGroupDelta(['src', 'm1'], { src: oldSrc, m1: member }, 'src', oldSrc, newSrc);
    expectVecClose(out.m1.position, [11, 2, 3]);
    expectVecClose(out.m1.quaternion, [0, 0, 0, 1]);
  });

  it('源不在 parts 字典里（如新建零件） → 跳过不报错', () => {
    const oldSrc: RigidPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    const newSrc: RigidPose = { position: [1, 0, 0], quaternion: [0, 0, 0, 1] };
    const out = applyGroupDelta(['src', 'missing'], { src: oldSrc }, 'src', oldSrc, newSrc);
    expect(out.missing).toBeUndefined();
    expect(out.src).toBe(newSrc);
  });
});

describe('交叉调用：calculateSnapPose ↔ applyGroupDelta scratch 不互染', () => {
  it('snap → delta → snap 三次连发仍各自正确', () => {
    const snap1 = calculateSnapPose([0, 0, 0], [0, 0, 0, 1], [1, 0, 0], [0, 0, 0, 1]);

    const oldSrc: RigidPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    const newSrc: RigidPose = { position: [2, 3, 4], quaternion: [0, 0, 0, 1] };
    applyGroupDelta(['s', 'm'], { s: oldSrc, m: { position: [9, 9, 9], quaternion: [0, 0, 0, 1] } }, 's', oldSrc, newSrc);

    const snap2 = calculateSnapPose([0, 0, 0], [0, 0, 0, 1], [1, 0, 0], [0, 0, 0, 1]);
    expectVecClose(snap1.position, snap2.position, 8);
    expectVecClose(snap1.quaternion, snap2.quaternion, 8);
  });
});

describe('calculatePortRotationPose: 端口 Z 轴旋转', () => {
  it('零角度旋转 → 零件位姿不变', () => {
    const partPos: [number, number, number] = [1, 2, 3];
    const partQuat: [number, number, number, number] = [0, 0, 0, 1];
    const pose = calculatePortRotationPose(partPos, partQuat, [0.1, 0, 0], [0, 0, 0, 1], 0);
    expectVecClose(pose.position, partPos);
    expectVecClose(pose.quaternion, partQuat);
  });

  it('端口在原点 + identity 旋转，绕端口 Z 转 90°：part 同样获得 Z 旋转 90°', () => {
    const pose = calculatePortRotationPose([0, 0, 0], [0, 0, 0, 1], [0, 0, 0], [0, 0, 0, 1], Math.PI / 2);
    expectVecClose(pose.position, [0, 0, 0]);
    // Z 轴 90° → quaternion (0, 0, sin(45°), cos(45°)) ≈ (0, 0, 0.7071, 0.7071)
    expect(pose.quaternion[2]).toBeCloseTo(Math.SQRT1_2);
    expect(pose.quaternion[3]).toBeCloseTo(Math.SQRT1_2);
  });

  it('1000 次连续旋转调用：每次输出对相同输入完全确定', () => {
    const args = [
      [0.5, 0.0, 0.0] as [number, number, number],
      [0, 0, 0, 1] as [number, number, number, number],
      [0.1, 0, 0] as [number, number, number],
      [0, 0, 0, 1] as [number, number, number, number],
      Math.PI / 4,
    ] as const;
    const first = calculatePortRotationPose(...args);
    for (let i = 0; i < 999; i++) calculatePortRotationPose(...args);
    const last = calculatePortRotationPose(...args);
    expectVecClose(first.position, last.position, 10);
    expectVecClose(first.quaternion, last.quaternion, 10);
  });
});

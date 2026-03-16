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

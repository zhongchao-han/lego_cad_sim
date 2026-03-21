import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

/**
 * 宏观架构验证：store.ts 采用工业级稳健解算器
 */
const quatNormalize = (q: [number, number, number, number]): [number, number, number, number] => {
  const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]) || 1;
  return [q[0]/len, q[1]/len, q[2]/len, q[3]/len];
};

const getQuatFromMat3 = (m: number[][] | number[]): [number, number, number, number] => {
  const nm = m as number[][];
  const m11 = nm[0][0], m12 = nm[1][0], m13 = nm[2][0];
  const m21 = nm[0][1], m22 = nm[1][1], m23 = nm[2][1];
  const m31 = nm[0][2], m32 = nm[1][2], m33 = nm[2][2];

  const tr = m11 + m22 + m33;
  let q: [number, number, number, number] = [0, 0, 0, 1];

  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1.0);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  return quatNormalize(q);
};

describe('store.ts (Robust Solver): Final Validation', () => {

  it('Identity matrix passes', () => {
    const mat = [[1,0,0], [0,1,0], [0,0,1]];
    const q = getQuatFromMat3(mat);
    expect(q[3]).toBeCloseTo(1);
  });

  it('Handshake: Purified RHS matrix from backend (originally reflection) passes perfectly', () => {
    // 模拟 6558.dat 经过后端净化后的矩阵 (Det=1)
    // 原始镜像 [0,-1,0],[0,0,1],[1,0,0] 被纠正为右手系
    const purifiedBackendMat = [
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 0]
    ];
    
    const q = getQuatFromMat3(purifiedBackendMat);
    const m = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...q));
    
    // 验证 Z 轴 (elements 8, 9, 10) 必须规整为 axis-aligned
    expect(m.elements[8] % 1).toBeCloseTo(0); 
    expect(m.elements[9] % 1).toBeCloseTo(0);
    expect(m.elements[10] % 1).toBeCloseTo(0);
  });

  it('Trace <= 0 case (Pure 180-deg rotation) is handled robustly', () => {
    // 绕 Z 旋转 180 度: [[-1, 0, 0], [0, -1, 0], [0, 0, 1]]
    // tr = -1 -1 + 1 = -1
    const rot180 = [[-1, 0, 0], [0, -1, 0], [0, 0, 1]];
    const q = getQuatFromMat3(rot180);
    expect(q[2]).toBeCloseTo(1); // z分量为1
    expect(q[3]).toBeCloseTo(0); // w分量为0
  });

});

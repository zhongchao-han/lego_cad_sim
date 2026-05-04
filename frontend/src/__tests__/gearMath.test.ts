/**
 * gearMath.test.ts — L44 齿轮咬合相位对齐
 * =========================================
 * 覆盖：
 *   - axesParallel：平行 / 反向平行 / 偏转
 *   - checkMeshGeometry：标准 mesh / 共轴 / 距离不匹配 / 轴向错位 / 非平行
 *   - computePhaseDelta：齿尖已对齐 / 偏 1/4 槽 / 偏半槽边界
 *   - rotateGearAroundOwnAxis：旋转后位姿合理
 *   - findMeshPartnerAndDelta：多候选选最近的 / 没匹配返 null
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  axesParallel,
  checkMeshGeometry,
  computePhaseDelta,
  findMeshPartnerAndDelta,
  getAxisWorld,
  LEGO_GEAR_MODULE_M,
  rotateGearAroundOwnAxis,
  type GearPart,
} from '../utils/gearMath';
import type { Quat, Vec3 } from '../types';

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

const expectClose = (a: number, b: number, eps = 1e-6) => {
  expect(Math.abs(a - b)).toBeLessThan(eps);
};

describe('axesParallel', () => {
  it('identical vectors are parallel', () => {
    expect(axesParallel(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1))).toBe(true);
  });
  it('opposite vectors still parallel (unsigned)', () => {
    expect(axesParallel(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1))).toBe(true);
  });
  it('orthogonal vectors not parallel', () => {
    expect(axesParallel(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))).toBe(false);
  });
  it('5 degree off — not parallel under default tolerance', () => {
    const a = new THREE.Vector3(0, 0, 1);
    const b = new THREE.Vector3(Math.sin(0.087), 0, Math.cos(0.087));  // ~5°
    expect(axesParallel(a, b)).toBe(false);
  });
});

describe('checkMeshGeometry', () => {
  const z = new THREE.Vector3(0, 0, 1);

  it('two 24-tooth gears at correct distance → matches', () => {
    const expected = (24 + 24) / 2 * LEGO_GEAR_MODULE_M;
    const dist = checkMeshGeometry(
      [0, 0, 0], z, [expected, 0, 0], z, 24, 24,
    );
    expect(dist).not.toBeNull();
    expectClose(dist!, expected);
  });

  it('asymmetric pair (12+24 tooth) at correct distance → matches', () => {
    const expected = (12 + 24) / 2 * LEGO_GEAR_MODULE_M;
    const dist = checkMeshGeometry(
      [0, 0, 0], z, [0, expected, 0], z, 12, 24,
    );
    expect(dist).not.toBeNull();
    expectClose(dist!, expected);
  });

  it('coaxial (planar dist 0) → null (no mesh, gears spin independently)', () => {
    expect(checkMeshGeometry([0, 0, 0], z, [0, 0, 0.01], z, 24, 24)).toBeNull();
  });

  it('distance off by 5mm → null', () => {
    const expected = (24 + 24) / 2 * LEGO_GEAR_MODULE_M;
    expect(
      checkMeshGeometry([0, 0, 0], z, [expected + 0.005, 0, 0], z, 24, 24),
    ).toBeNull();
  });

  it('axes not parallel → null', () => {
    const x = new THREE.Vector3(1, 0, 0);
    const expected = (24 + 24) / 2 * LEGO_GEAR_MODULE_M;
    expect(
      checkMeshGeometry([0, 0, 0], z, [expected, 0, 0], x, 24, 24),
    ).toBeNull();
  });

  it('axes parallel but z-错位 too much → null（v1 不算 mesh）', () => {
    const expected = (24 + 24) / 2 * LEGO_GEAR_MODULE_M;
    // 沿 axis 错开 2 个 module（远超 1 module 容差）
    expect(
      checkMeshGeometry([0, 0, 0], z, [expected, 0, 2 * LEGO_GEAR_MODULE_M], z, 24, 24),
    ).toBeNull();
  });
});

describe('computePhaseDelta', () => {
  it('partner at gear local +X 的 24 齿整数倍位置 → delta ≈ 0', () => {
    // gear 在原点 identity，partner 沿世界 +X 方向距离 (24+24)/2 module
    const dist = (24 + 24) / 2 * LEGO_GEAR_MODULE_M;
    const delta = computePhaseDelta([0, 0, 0], IDENTITY_QUAT, [dist, 0, 0], 24);
    expectClose(delta, 0);
  });

  it('partner 在 gear 局部 +X 转 1/4 齿槽方向 → delta ≈ slot/4', () => {
    const T = 24;
    const slot = (2 * Math.PI) / T;
    const dist = T * LEGO_GEAR_MODULE_M;
    const angle = slot / 4; // 偏出 +X 一点点
    const px = Math.cos(angle) * dist;
    const py = Math.sin(angle) * dist;
    const delta = computePhaseDelta([0, 0, 0], IDENTITY_QUAT, [px, py, 0], T);
    expectClose(delta, slot / 4);
  });

  it('|delta| 永远 ≤ slot/2（最小转动）', () => {
    const T = 24;
    const slot = (2 * Math.PI) / T;
    const dist = T * LEGO_GEAR_MODULE_M;
    // 试 100 个随机角，断言都在范围内
    for (let i = 0; i < 100; i++) {
      const angle = Math.random() * Math.PI * 2;
      const px = Math.cos(angle) * dist;
      const py = Math.sin(angle) * dist;
      const delta = computePhaseDelta([0, 0, 0], IDENTITY_QUAT, [px, py, 0], T);
      expect(Math.abs(delta)).toBeLessThanOrEqual(slot / 2 + 1e-9);
    }
  });

  it('toothCount=0 退化返 0', () => {
    expect(computePhaseDelta([0, 0, 0], IDENTITY_QUAT, [1, 0, 0], 0)).toBe(0);
  });
});

describe('rotateGearAroundOwnAxis', () => {
  it('zero delta returns equivalent quaternion', () => {
    const q = rotateGearAroundOwnAxis(IDENTITY_QUAT, 0);
    expectClose(q[0], 0);
    expectClose(q[1], 0);
    expectClose(q[2], 0);
    expectClose(q[3], 1);
  });

  it('rotate 90° around local Z 给出 Z 轴四元数', () => {
    const q = rotateGearAroundOwnAxis(IDENTITY_QUAT, Math.PI / 2);
    expectClose(q[2], Math.SQRT1_2);
    expectClose(q[3], Math.SQRT1_2);
  });
});

describe('getAxisWorld', () => {
  it('identity quat → +Z', () => {
    const out = getAxisWorld(IDENTITY_QUAT);
    expectClose(out.x, 0);
    expectClose(out.y, 0);
    expectClose(out.z, 1);
  });

  it('quat Ry(+90°) 把 +Z 转到 +X', () => {
    // Ry(+π/2): quat = [0, sin(π/4), 0, cos(π/4)] = [0, √2/2, 0, √2/2]
    // Ry(θ) · (0,0,1)ᵀ = (sin θ, 0, cos θ)；θ=+π/2 → (1, 0, 0)
    const q: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const out = getAxisWorld(q);
    expectClose(out.x, 1);
    expectClose(Math.abs(out.y), 0);
    expectClose(out.z, 0);
  });
});

describe('findMeshPartnerAndDelta', () => {
  const make = (id: string, pos: Vec3, T: number): GearPart => ({
    partId: id, ldrawId: 'gear', position: pos, quaternion: IDENTITY_QUAT, toothCount: T,
  });

  it('单一匹配 partner → 返回它', () => {
    const source = make('G1', [0, 0, 0], 24);
    const dist = (24 + 24) / 2 * LEGO_GEAR_MODULE_M;
    const partner = make('G2', [dist, 0, 0], 24);
    const result = findMeshPartnerAndDelta(source, [partner]);
    expect(result).not.toBeNull();
    expect(result!.partner.partId).toBe('G2');
    expectClose(result!.delta, 0);
  });

  it('多个候选取距离最接近预期的那个', () => {
    const source = make('G1', [0, 0, 0], 24);
    const exact = (24 + 24) / 2 * LEGO_GEAR_MODULE_M;
    // 一个稍远的候选（仍在容差内 1mm）+ 一个完全准确的候选
    const sloppy  = make('G_far',  [exact + 0.0009, 0, 0], 24);
    const perfect = make('G_near', [0, exact, 0], 24);
    const result = findMeshPartnerAndDelta(source, [sloppy, perfect]);
    expect(result).not.toBeNull();
    expect(result!.partner.partId).toBe('G_near');
  });

  it('无匹配返 null', () => {
    const source = make('G1', [0, 0, 0], 24);
    // 距离 1 米，远超任何齿轮 mesh
    const partner = make('G2', [1.0, 0, 0], 24);
    const result = findMeshPartnerAndDelta(source, [partner]);
    expect(result).toBeNull();
  });

  it('source 在 candidates 中 — 跳过自己不会匹配', () => {
    const source = make('G1', [0, 0, 0], 24);
    const result = findMeshPartnerAndDelta(source, [source]);
    expect(result).toBeNull();
  });
});

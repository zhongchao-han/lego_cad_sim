/**
 * fitMath.test.ts — L46 物理过盈反馈
 * ====================================
 * 覆盖：
 *   - getInterface：精确匹配 / 去 .dat / 前缀模糊
 *   - checkFit：极性 / 截面 / 半径差三层判定
 *   - fitForSlide：自动按极性选 plug，AXIAL_SLIDING 场景包装
 *   - getSlideStepFactor：FitType → 步长缩放映射
 *   - 同源约束：核心配对必须与 backend/port_semantics.py 一致（drift 即报错）
 */
import { describe, it, expect } from 'vitest';
import {
  FitType,
  Gender,
  Profile,
  checkFit,
  checkFitByTypes,
  fitDisplayLabel,
  fitForSlide,
  getInterface,
  getSlideStepFactor,
} from '../utils/fitMath';

describe('getInterface', () => {
  it('exact match returns interface', () => {
    const pin = getInterface('pin');
    expect(pin).not.toBeNull();
    expect(pin!.gender).toBe(Gender.MALE);
    expect(pin!.profile).toBe(Profile.CYLINDER);
  });

  it('strip .dat then lookup', () => {
    expect(getInterface('pin.dat')).toEqual(getInterface('pin'));
  });

  it('prefix fallback for variant ldraw names', () => {
    // stud3a.dat 不在表里 → 通过 stud 前缀匹配
    const stud3a = getInterface('stud3a.dat');
    expect(stud3a).not.toBeNull();
    expect(stud3a!.profile).toBe(Profile.STUD);
  });

  it('case-insensitive', () => {
    expect(getInterface('PIN')).toEqual(getInterface('pin'));
  });

  it('unknown type returns null', () => {
    expect(getInterface('xyzfoo')).toBeNull();
    expect(getInterface('')).toBeNull();
  });
});

describe('checkFit', () => {
  it('classic pin + peghole = CLEARANCE (5.9 < 6.0)', () => {
    expect(checkFitByTypes('pin', 'peghole')).toBe(FitType.CLEARANCE);
  });

  it('friction pin + peghole = FRICTION (6.2 > 6.0, but Δ ≤ 0.3mm)', () => {
    expect(checkFitByTypes('fric_pin.dat', 'peghole')).toBe(FitType.FRICTION);
  });

  it('axle + axlehole = CLEARANCE (3.9 < 4.0, both CROSS)', () => {
    expect(checkFitByTypes('axle', 'axlehole')).toBe(FitType.CLEARANCE);
  });

  it('两 MALE 不兼容', () => {
    expect(checkFitByTypes('pin', 'axle')).toBe(FitType.INCOMPATIBLE);
  });

  it('两 FEMALE 不兼容', () => {
    expect(checkFitByTypes('peghole', 'axlehole')).toBe(FitType.INCOMPATIBLE);
  });

  it('截面不一致（CYLINDER pin 插入 CROSS axlehole）不兼容', () => {
    expect(checkFitByTypes('pin', 'axlehole')).toBe(FitType.INCOMPATIBLE);
  });

  it('BLOCKED 路径（手工伪造一个超大销径）', () => {
    const oversized = {
      gender: Gender.MALE, profile: Profile.CYLINDER,
      radius: 7.0 * 0.0004, depth: 0.01,  // 7.0 LDU > 孔 6.0 LDU + 0.3mm tolerance
    };
    const peghole = getInterface('peghole')!;
    expect(checkFit(oversized, peghole)).toBe(FitType.BLOCKED);
  });
});

describe('fitForSlide (极性自动）', () => {
  it('peghole + pin（顺序反着传）→ CLEARANCE 不报 INCOMPATIBLE', () => {
    expect(fitForSlide('peghole', 'pin')).toBe(FitType.CLEARANCE);
    expect(fitForSlide('pin', 'peghole')).toBe(FitType.CLEARANCE);
  });

  it('两 MALE 时仍 INCOMPATIBLE', () => {
    expect(fitForSlide('pin', 'axle')).toBe(FitType.INCOMPATIBLE);
  });
});

describe('getSlideStepFactor', () => {
  it('CLEARANCE × 1.0 = 全速', () => {
    expect(getSlideStepFactor(FitType.CLEARANCE)).toBe(1.0);
  });

  it('FRICTION × 0.25 = 4 倍按键才走 1 LDU', () => {
    expect(getSlideStepFactor(FitType.FRICTION)).toBe(0.25);
  });

  it('INTERFERENCE × 0.1 = 极卡', () => {
    expect(getSlideStepFactor(FitType.INTERFERENCE)).toBe(0.1);
  });

  it('BLOCKED / INCOMPATIBLE × 0 = 锁死', () => {
    expect(getSlideStepFactor(FitType.BLOCKED)).toBe(0);
    expect(getSlideStepFactor(FitType.INCOMPATIBLE)).toBe(0);
  });
});

describe('fitDisplayLabel', () => {
  it('每个 FitType 都有可读标签', () => {
    for (const f of Object.values(FitType)) {
      const label = fitDisplayLabel(f);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ── L46 同源 drift 哨兵 ────────────────────────────────────────────────────
// backend/port_semantics.py 的核心配对必须与本表一致；任何一项变了，
// 这个哨兵会立刻抓到。drift 时同步 frontend/src/utils/fitMath.ts。
describe('drift 哨兵：核心 fit 配对', () => {
  it('pin/peghole 系列 = CLEARANCE', () => {
    expect(checkFitByTypes('pin', 'peghole')).toBe(FitType.CLEARANCE);
    expect(checkFitByTypes('pin.dat', 'beamhole.dat')).toBe(FitType.CLEARANCE);
    expect(checkFitByTypes('peg', 'connhole.dat')).toBe(FitType.CLEARANCE);
  });

  it('摩擦销系列 = FRICTION', () => {
    expect(checkFitByTypes('fric_pin.dat', 'peghole')).toBe(FitType.FRICTION);
    expect(checkFitByTypes('confric3.dat', 'beamhole.dat')).toBe(FitType.FRICTION);
    expect(checkFitByTypes('confric8.dat', 'peghole')).toBe(FitType.FRICTION);
  });

  it('axle 系列锁死 = CLEARANCE（Δ=-0.1 LDU < 0）', () => {
    expect(checkFitByTypes('axle', 'axlehole')).toBe(FitType.CLEARANCE);
    expect(checkFitByTypes('axle.dat', 'axlehole.dat')).toBe(FitType.CLEARANCE);
  });
});

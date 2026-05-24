/**
 * siteGizmo_compat.test.ts
 * ========================
 * A7 — 极性不兼容置灰 (EDITOR Test 4.2) 单测
 *
 * 覆盖 SiteGizmo.tsx 内部两个粗糙规则函数：
 *   - isFemale(port)：gender 显式优先，否则按 type 名 hint
 *   - isCompatible(sourcePortType, targetPort)：极性互补判定（一孔一插）
 *
 * 两者都是 PortArrow 6 处 UI 守卫（颜色置灰 / hover 屏蔽 / click 屏蔽 /
 * directional hitbox 不渲染）的决策源。规则改动时单测先红、定位极快。
 *
 * ⚠ 已知粗糙度：isCompatible 不区分 STUD/CROSS profile。spec Test 4.2
 *   严格语义在 fitMath.ts checkFit 才有；SiteGizmo 这层只过极性。后续
 *   把 profile 也接进 isCompatible 时本文件会有 case 红，正常。
 */

import { describe, it, expect } from 'vitest';
import { isFemale, isCompatible, portProminent } from '../components/SiteGizmo';
import type { LDrawPort } from '../useLDrawPart';

const EYE3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function makePort(type: string, gender?: LDrawPort['gender']): LDrawPort {
  return {
    name: `port_${type}`,
    type,
    gender,
    position: [0, 0, 0],
    rotation: EYE3,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// isCompatible — 决策矩阵
// ─────────────────────────────────────────────────────────────────────────
describe('isCompatible — 极性互补判定', () => {
  it('case 1: sourcePortType=null（SOURCE_LOCKED 未设）→ 全显，永远兼容', () => {
    expect(isCompatible(null, makePort('peghole.dat'))).toBe(true);
    expect(isCompatible(null, makePort('peg.dat'))).toBe(true);
    expect(isCompatible(null, makePort('axle.dat'))).toBe(true);
  });

  it('case 2: peg.dat (MALE) × peghole.dat (FEMALE) → 兼容', () => {
    expect(isCompatible('peg.dat', makePort('peghole.dat'))).toBe(true);
  });

  it('case 3: peghole.dat (FEMALE) × peg.dat (MALE) → 兼容（顺序无关）', () => {
    expect(isCompatible('peghole.dat', makePort('peg.dat'))).toBe(true);
  });

  it('case 4: peg.dat × peg.dat → 同性 MALE×MALE，不兼容', () => {
    expect(isCompatible('peg.dat', makePort('peg.dat'))).toBe(false);
  });

  it('case 5: peghole.dat × peghole.dat → 同性 FEMALE×FEMALE，不兼容', () => {
    expect(isCompatible('peghole.dat', makePort('peghole.dat'))).toBe(false);
  });

  it('case 6: axle.dat × axlehole → 兼容（粗糙规则只看极性，不区分 CROSS/CYLINDER profile）', () => {
    // 已知 gap：spec Test 4.2 严格语义需要 profile 也参与判定
    // (axle 是 CROSS 截面，peghole 是 CYLINDER，这两不应兼容)；
    // SiteGizmo 这层粗糙规则给 true，未来接 profile 后 case 翻红。
    expect(isCompatible('axle.dat', makePort('axlehole'))).toBe(true);
  });

  it('case 7: target 显式 gender=FEMALE 覆盖 type=peg.dat → 仍按 gender 判 FEMALE，与 src peg 兼容', () => {
    expect(isCompatible('peg.dat', makePort('peg.dat', 'FEMALE'))).toBe(true);
  });

  it('case 8: target 显式 gender=MALE 覆盖 type=peghole → 仍按 gender 判 MALE，与 src peg 同性不兼容', () => {
    expect(isCompatible('peg.dat', makePort('peghole', 'MALE'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isFemale — gender vs type 优先级
// ─────────────────────────────────────────────────────────────────────────
describe('isFemale — gender 显式优先 / type hint fallback', () => {
  it('case 9: gender=FEMALE 即使 type=peg.dat（看似 MALE）也判 FEMALE', () => {
    expect(isFemale(makePort('peg.dat', 'FEMALE'))).toBe(true);
  });

  it('case 10: gender=MALE 即使 type=peghole.dat（看似 FEMALE）也判 MALE', () => {
    expect(isFemale(makePort('peghole.dat', 'MALE'))).toBe(false);
  });

  it('case 11: 无 gender + type=peghole.dat → type hint → FEMALE', () => {
    expect(isFemale(makePort('peghole.dat'))).toBe(true);
  });

  it('case 12: 无 gender + type 含短匹配 "hol"（如 npeghol.dat / connhol.dat）→ FEMALE', () => {
    expect(isFemale(makePort('npeghol.dat'))).toBe(true);
    expect(isFemale(makePort('connhol.dat'))).toBe(true);
    // 边界：纯 'hol' 子串命中（虽然不是真实 LDraw 端口名，验证逻辑覆盖）
    expect(isFemale(makePort('xx_hol_yy'))).toBe(true);
  });

  it('case 13: 无 gender + type=peg.dat → 无 hint → MALE', () => {
    expect(isFemale(makePort('peg.dat'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// portProminent — 端口显著高亮判定（连接件埋体内端口的 Alt 全亮）
// ─────────────────────────────────────────────────────────────────────────
describe('portProminent — 高亮判定（含连接件 Alt 全亮）', () => {
  const base = {
    hovered: false, portEngageMode: false, isSelected: false, debugShowPorts: false,
    isConnectorPart: false, shouldShowVisuals: false, isCompatiblePort: true,
  };

  it('精确 hover 到端口 + Alt → 高亮', () => {
    expect(portProminent({ ...base, hovered: true, portEngageMode: true })).toBe(true);
  });

  it('hover 到端口但没按 Alt → 不高亮（裸点是选本体）', () => {
    expect(portProminent({ ...base, hovered: true, portEngageMode: false })).toBe(false);
  });

  it('已选源端口 / Debug 全显 → 恒高亮', () => {
    expect(portProminent({ ...base, isSelected: true })).toBe(true);
    expect(portProminent({ ...base, debugShowPorts: true })).toBe(true);
  });

  it('连接件 + 本件激活 + Alt + 兼容 → 整件端口全亮（无需精确 hover）', () => {
    expect(portProminent({ ...base, isConnectorPart: true, shouldShowVisuals: true, portEngageMode: true })).toBe(true);
  });

  it('连接件但没按 Alt → 不全亮', () => {
    expect(portProminent({ ...base, isConnectorPart: true, shouldShowVisuals: true, portEngageMode: false })).toBe(false);
  });

  it('连接件 + Alt 但端口不兼容 → 不全亮（避免误导可连）', () => {
    expect(portProminent({ ...base, isConnectorPart: true, shouldShowVisuals: true, portEngageMode: true, isCompatiblePort: false })).toBe(false);
  });

  it('非连接件（大板）+ Alt + 激活但未精确 hover → 不全亮（防铺满）', () => {
    expect(portProminent({ ...base, isConnectorPart: false, shouldShowVisuals: true, portEngageMode: true })).toBe(false);
  });
});

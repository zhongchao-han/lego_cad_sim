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
describe('portProminent — 高亮判定（Option+hover 显示非密集件全部端口）', () => {
  const base = {
    hovered: false, portEngageMode: false, isSelected: false, debugShowPorts: false,
    isDensePart: false, shouldShowVisuals: false, isCompatiblePort: true,
  };

  it('精确 hover 到端口 + Option → 高亮', () => {
    expect(portProminent({ ...base, hovered: true, portEngageMode: true })).toBe(true);
  });

  it('hover 到端口但没按 Option → 不高亮（裸 hover 不显示，裸点选本体）', () => {
    expect(portProminent({ ...base, hovered: true, portEngageMode: false })).toBe(false);
  });

  it('已选源端口 / Debug 全显 → 恒高亮', () => {
    expect(portProminent({ ...base, isSelected: true })).toBe(true);
    expect(portProminent({ ...base, debugShowPorts: true })).toBe(true);
  });

  it('非密集件（销/小板）+ Option + 本件激活 + 兼容 → 整件端口全亮（无需精确 hover）', () => {
    expect(portProminent({ ...base, isDensePart: false, shouldShowVisuals: true, portEngageMode: true })).toBe(true);
  });

  it('非密集件但没按 Option → 不全亮（必须 Option+hover）', () => {
    expect(portProminent({ ...base, isDensePart: false, shouldShowVisuals: true, portEngageMode: false })).toBe(false);
  });

  it('非密集件 + Option 但端口不兼容 → 不全亮（避免误导可连）', () => {
    expect(portProminent({ ...base, isDensePart: false, shouldShowVisuals: true, portEngageMode: true, isCompatiblePort: false })).toBe(false);
  });

  it('密集件（大板 390 孔）+ Option + 激活但未精确 hover → 不全亮（防铺满）', () => {
    expect(portProminent({ ...base, isDensePart: true, shouldShowVisuals: true, portEngageMode: true })).toBe(false);
  });

  it('密集件 + Option + 精确 hover 到某端口 → 亮该端口', () => {
    expect(portProminent({ ...base, isDensePart: true, hovered: true, portEngageMode: true })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// portProminent — spotlight 模式（解决密集 port 区"周围全亮分不清要点哪个"）
// 父层（InteractivePart）每帧算"屏幕距离 cursor 最近的兼容 port"塞 spotlightPortKey
// 给 SiteGizmo → PortArrow；PortArrow 算 spotlightActive + isSpotlightWinner 喂 portProminent。
// ─────────────────────────────────────────────────────────────────────────
describe('portProminent — spotlight 模式（减少密集 port 区视觉杂讯）', () => {
  const base = {
    hovered: false, portEngageMode: false, isSelected: false, debugShowPorts: false,
    isDensePart: false, shouldShowVisuals: false, isCompatiblePort: true,
  };

  it('spotlightActive=false → 行为同老逻辑（兼容 port 全亮）', () => {
    // 不传 spotlight 参数等价 spotlightActive=false
    expect(portProminent({ ...base, shouldShowVisuals: true, portEngageMode: true })).toBe(true);
  });

  it('spotlightActive=true + isSpotlightWinner=true → 仅 winner 亮', () => {
    expect(portProminent({
      ...base, shouldShowVisuals: true, portEngageMode: true,
      spotlightActive: true, isSpotlightWinner: true,
    })).toBe(true);
  });

  it('spotlightActive=true + isSpotlightWinner=false → 兼容但 dim（不再 prominent）', () => {
    expect(portProminent({
      ...base, shouldShowVisuals: true, portEngageMode: true,
      spotlightActive: true, isSpotlightWinner: false,
    })).toBe(false);
  });

  it('spotlight 模式下，hovered（精确鼠标在我身上）+ Option → 仍恒高亮（不受 spotlight 降级）', () => {
    expect(portProminent({
      ...base, hovered: true, portEngageMode: true,
      spotlightActive: true, isSpotlightWinner: false,
    })).toBe(true);
  });

  it('spotlight 模式下，isSelected（source 锁定）→ 仍恒高亮', () => {
    expect(portProminent({
      ...base, isSelected: true,
      spotlightActive: true, isSpotlightWinner: false,
    })).toBe(true);
  });

  it('spotlight 模式下，debugShowPorts → 仍恒高亮（Debug 是逃生口）', () => {
    expect(portProminent({
      ...base, debugShowPorts: true,
      spotlightActive: true, isSpotlightWinner: false,
    })).toBe(true);
  });

  it('spotlight 模式下，不兼容 port → 降级（不亮）', () => {
    expect(portProminent({
      ...base, shouldShowVisuals: true, portEngageMode: true, isCompatiblePort: false,
      spotlightActive: true, isSpotlightWinner: true,
    })).toBe(false);
  });

  it('isTargetSeekingPhase=true（SOURCE_LOCKED）+ spotlight winner → 即使没按 Alt 也亮', () => {
    // 用户已点 source，正在找 target；不再要求持续按 Alt（已显式在找 target 模式）。
    expect(portProminent({
      ...base, shouldShowVisuals: true, portEngageMode: false /* no Alt */,
      spotlightActive: true, isSpotlightWinner: true,
      isTargetSeekingPhase: true,
    })).toBe(true);
  });

  it('isTargetSeekingPhase=true + 密集件 + spotlight winner → 亮（spotlight 限 1 个不会铺满）', () => {
    // 解决"在底板 390 孔密集件上 hover 时，cursor 边没有视觉指示"
    expect(portProminent({
      ...base, isDensePart: true, shouldShowVisuals: true, portEngageMode: false,
      spotlightActive: true, isSpotlightWinner: true,
      isTargetSeekingPhase: true,
    })).toBe(true);
  });

  it('isTargetSeekingPhase=true + spotlight loser → 不亮（即使在 target 阶段也只让 winner 亮）', () => {
    expect(portProminent({
      ...base, shouldShowVisuals: true, portEngageMode: false,
      spotlightActive: true, isSpotlightWinner: false,
      isTargetSeekingPhase: true,
    })).toBe(false);
  });
});

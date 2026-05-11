/**
 * siteGizmo_plug_halo.test.ts
 * ============================
 * 走法 A 期 B.1 — plug-sibling halo 触发条件单测。
 *
 * 覆盖 SiteGizmo.shouldHaloPlugSibling — 当用户 hover 一个 port 时，同 plug
 * 的兄弟 port 应该自渲染暖黄 halo（user 视觉看见 plug 边界）。
 *
 * 关键边界：
 *   - 装饰类零件 / 老数据无 plug_id → 不联动
 *   - 跨 part 同 plug_id 字符串巧合 → 不联动（partId 命名空间隔离）
 *   - 被 hover 的那个 port 本身不加 halo（避免重复视觉）
 *   - selected port 不加 halo（已有 ACTIVE_COLOR 高亮）
 */

import { describe, it, expect } from 'vitest';
import { shouldHaloPlugSibling } from '../components/SiteGizmo';
import type { SelectedPortInfo } from '../types';

function makeHoveredPort(overrides: Partial<SelectedPortInfo> = {}): SelectedPortInfo {
  return {
    partId: 'partA',
    ldrawId: '170.dat',
    portType: 'stud',
    position: [0, 0, 0],
    rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    globalPos: [0, 0, 0],
    globalQuat: [0, 0, 0, 1],
    plug_id: '170.dat_plug_0',
    ...overrides,
  };
}

describe('shouldHaloPlugSibling', () => {
  it('case 1: 同 part + 同 plug_id + 非自身 hover/select → halo', () => {
    expect(
      shouldHaloPlugSibling({
        portPlugId: '170.dat_plug_0',
        portPartId: 'partA',
        hoveredPort: makeHoveredPort(),
        isThisPortHovered: false,
        isThisPortSelected: false,
      }),
    ).toBe(true);
  });

  it('case 2: 本 port 无 plug_id（装饰类 / 老数据）→ 不 halo', () => {
    expect(
      shouldHaloPlugSibling({
        portPlugId: undefined,
        portPartId: 'partA',
        hoveredPort: makeHoveredPort(),
        isThisPortHovered: false,
        isThisPortSelected: false,
      }),
    ).toBe(false);
  });

  it('case 3: 无 port 在 hover → 不 halo', () => {
    expect(
      shouldHaloPlugSibling({
        portPlugId: '170.dat_plug_0',
        portPartId: 'partA',
        hoveredPort: null,
        isThisPortHovered: false,
        isThisPortSelected: false,
      }),
    ).toBe(false);
  });

  it('case 4: hover 的 port 无 plug_id → 不 halo（hover 装饰零件不联动）', () => {
    expect(
      shouldHaloPlugSibling({
        portPlugId: '170.dat_plug_0',
        portPartId: 'partA',
        hoveredPort: makeHoveredPort({ plug_id: undefined }),
        isThisPortHovered: false,
        isThisPortSelected: false,
      }),
    ).toBe(false);
  });

  it('case 5: plug_id 不同 → 不 halo（顶 stud plug vs 底 stud plug）', () => {
    expect(
      shouldHaloPlugSibling({
        portPlugId: '170.dat_plug_1',                            // 底
        portPartId: 'partA',
        hoveredPort: makeHoveredPort({ plug_id: '170.dat_plug_0' }), // 顶
        isThisPortHovered: false,
        isThisPortSelected: false,
      }),
    ).toBe(false);
  });

  it('case 6: 跨 part（同 ldrawId 实例化两次）+ plug_id 字符串相同 → 不 halo', () => {
    // 场景：用户场景里有两块 170.dat。partA 的 hover 不应让 partB 的同名 plug 联动。
    expect(
      shouldHaloPlugSibling({
        portPlugId: '170.dat_plug_0',
        portPartId: 'partB',                       // 跨 part
        hoveredPort: makeHoveredPort({ partId: 'partA', plug_id: '170.dat_plug_0' }),
        isThisPortHovered: false,
        isThisPortSelected: false,
      }),
    ).toBe(false);
  });

  it('case 7: 本身就是 hovered port → 不 halo（避免重复视觉，走常规 hover 路径）', () => {
    expect(
      shouldHaloPlugSibling({
        portPlugId: '170.dat_plug_0',
        portPartId: 'partA',
        hoveredPort: makeHoveredPort(),
        isThisPortHovered: true,                   // 本 port 就是 hover 目标
        isThisPortSelected: false,
      }),
    ).toBe(false);
  });

  it('case 8: 本 port 是 selected（橙色 ACTIVE_COLOR）→ 不 halo（已有高亮）', () => {
    expect(
      shouldHaloPlugSibling({
        portPlugId: '170.dat_plug_0',
        portPartId: 'partA',
        hoveredPort: makeHoveredPort(),
        isThisPortHovered: false,
        isThisPortSelected: true,
      }),
    ).toBe(false);
  });

  it('case 9: 跨 site 同 plug（贯通孔合并）— 用 plug_id 字符串等价判定，site 不参与', () => {
    // 9-hole beam 顶面 site 的 port hover；底面 site 的同 plug member 仍应 halo。
    // 这里函数不直接接触 site_id，靠 plug_id 字符串等价判定就够 — 跨 site 是数据
    // 层的事，halo 触发逻辑不需要感知。
    expect(
      shouldHaloPlugSibling({
        portPlugId: '40490.dat_plug_0',
        portPartId: 'partBeam',
        hoveredPort: makeHoveredPort({
          partId: 'partBeam',
          ldrawId: '40490.dat',
          plug_id: '40490.dat_plug_0',
        }),
        isThisPortHovered: false,
        isThisPortSelected: false,
      }),
    ).toBe(true);
  });
});

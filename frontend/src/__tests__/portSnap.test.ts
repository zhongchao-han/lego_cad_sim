/**
 * portSnap.test.ts
 * ================
 * 验证 `computeSnapDelta`（utils/portSnap.ts）的核心契约：
 *   1. 候选 = 法向反对 + 距离 < searchRadius
 *   2. 评分 = 把整组平移 delta 后能落进 lockThreshold 的 port 对数
 *   3. 分数最高赢、同分取 delta 最短
 *   4. userIntentDelta 提供时过滤掉反向拉用户的候选
 *      (dot(snap_delta, user_intent) < 0 → drop)
 *
 * 这块逻辑跟具体场景几何无关，纯函数 + 小输入即可全覆盖。
 */
import { describe, it, expect } from 'vitest';
import { computeSnapDelta, SNAP_SEARCH_RADIUS, SNAP_LOCK_THRESHOLD, type SnapPartInput, type SnapPortInput } from '../utils/portSnap';

// 法向 z=+1 的 port：rotation 3rd col = (0,0,1) → 用 identity 矩阵
const portFacingPlusZ = (pos: [number, number, number]): SnapPortInput => ({
  position: pos,
  rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
});
// 法向 z=-1 的 port：rotation 3rd col = (0,0,-1) → row3 z 项变 -1
const portFacingMinusZ = (pos: [number, number, number]): SnapPortInput => ({
  position: pos,
  rotation: [[1, 0, 0], [0, -1, 0], [0, 0, -1]], // 绕 x 翻 180°
});
// 法向 x=+1：第 3 列 = (1,0,0)
const portFacingPlusX = (pos: [number, number, number]): SnapPortInput => ({
  position: pos,
  rotation: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
});

const partAtOrigin = (id: string, ldrawId: string): SnapPartInput => ({
  id, ldrawId,
  position: [0, 0, 0], quaternion: [0, 0, 0, 1],
});
const partAt = (id: string, ldrawId: string, pos: [number, number, number]): SnapPartInput => ({
  id, ldrawId,
  position: pos, quaternion: [0, 0, 0, 1],
});

describe('computeSnapDelta: 基本对齐挑选', () => {
  it('动件 port 与静件 port 距离 4mm、法向反对 → 给出 (+4mm) delta 把动件吸过去', () => {
    const moving = [partAtOrigin('m', 'M')];
    const staticP = [partAt('s', 'S', [0.004, 0, 0])];
    const ports = {
      M: [portFacingPlusZ([0, 0, 0])],
      S: [portFacingMinusZ([0, 0, 0])], // 静件本地 port at (0,0,0), 法向 -z
    };
    const delta = computeSnapDelta(moving, staticP, ports);
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(0.004, 6);
    expect(delta![1]).toBeCloseTo(0, 6);
    expect(delta![2]).toBeCloseTo(0, 6);
  });

  it('已经在 lockThreshold 内（< 1mm）→ 返 null（不必触发吸附）', () => {
    const moving = [partAtOrigin('m', 'M')];
    const staticP = [partAt('s', 'S', [0.0005, 0, 0])]; // 0.5mm
    const ports = {
      M: [portFacingPlusZ([0, 0, 0])],
      S: [portFacingMinusZ([0, 0, 0])],
    };
    expect(computeSnapDelta(moving, staticP, ports)).toBeNull();
  });

  it('超出 searchRadius（> 8mm）→ 返 null', () => {
    const moving = [partAtOrigin('m', 'M')];
    const staticP = [partAt('s', 'S', [0.02, 0, 0])]; // 20mm
    const ports = {
      M: [portFacingPlusZ([0, 0, 0])],
      S: [portFacingMinusZ([0, 0, 0])],
    };
    expect(computeSnapDelta(moving, staticP, ports)).toBeNull();
  });

  it('法向同向（不反对）→ 不算候选 → 返 null', () => {
    const moving = [partAtOrigin('m', 'M')];
    const staticP = [partAt('s', 'S', [0.004, 0, 0])];
    const ports = {
      M: [portFacingPlusZ([0, 0, 0])],
      S: [portFacingPlusZ([0, 0, 0])], // 也 +z → 同向
    };
    expect(computeSnapDelta(moving, staticP, ports)).toBeNull();
  });
});

describe('computeSnapDelta: 多候选评分（最多对齐胜）', () => {
  it('两个候选 delta：选能让最多 port 对落进 1mm 阈值的那个', () => {
    // 动件 M 2 个 port，沿 +x **间距 3mm**（故意跟 A 不同间距，A 只能匹配 1 个）
    // 静件 A：1 个 port at (0.004, 0, 0)  → 只匹配 M 第 1 个 port，delta=+0.004，score=1
    // 静件 B：2 个 port 沿 +x **间距 3mm**（跟 M 同间距）→ delta=+0.005 时两 port 都对齐，score=2
    // → B 评分高，B 的 delta 胜
    const moving = [partAtOrigin('m', 'M')];
    const staticP = [partAt('a', 'A', [0, 0, 0]), partAt('b', 'B', [0, 0, 0])];
    const ports = {
      M: [portFacingPlusZ([0, 0, 0]), portFacingPlusZ([0.003, 0, 0])],
      A: [portFacingMinusZ([0.004, 0, 0])],
      B: [portFacingMinusZ([0.005, 0, 0]), portFacingMinusZ([0.008, 0, 0])],
    };
    const delta = computeSnapDelta(moving, staticP, ports);
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(0.005, 6); // B 的 delta 胜（评分 2 vs A 评分 1）
  });

  it('同分时取 delta 最短（最小动作干扰）', () => {
    // 两个候选都让 1 对 port 对齐（score 都 = 1），其中一个 delta 短 → 它胜
    const moving = [partAtOrigin('m', 'M')];
    const staticP = [partAt('near', 'NEAR', [0, 0, 0]), partAt('far', 'FAR', [0, 0, 0])];
    const ports = {
      M: [portFacingPlusZ([0, 0, 0])],
      NEAR: [portFacingMinusZ([0.002, 0, 0])], // 2mm 远
      FAR: [portFacingMinusZ([0.006, 0, 0])],  // 6mm 远
    };
    const delta = computeSnapDelta(moving, staticP, ports);
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(0.002, 6); // 选短的
  });
});

describe('computeSnapDelta: userIntentDelta 方向过滤（防止反拉用户）', () => {
  // 用户按 D 想 +8mm in X。snap 看到原位置 8mm 之外有匹配候选 → 不应反向拉回。
  const moving = [partAtOrigin('m', 'M')];
  const staticP = [partAt('s', 'S', [-0.008, 0, 0])]; // 静件在 -x 方向 8mm
  const ports = {
    M: [portFacingPlusZ([0, 0, 0])],
    S: [portFacingMinusZ([0, 0, 0])], // 静件 port 在 (-8mm, 0, 0)
  };

  it('不传 userIntentDelta → 不过滤，给出反向 -8mm 的 delta', () => {
    const delta = computeSnapDelta(moving, staticP, ports);
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(-0.008, 6);
  });

  it('userIntentDelta = +x 方向 → snap delta -x 被反向过滤 → 返 null', () => {
    const delta = computeSnapDelta(moving, staticP, ports, { userIntentDelta: [+0.008, 0, 0] });
    expect(delta).toBeNull();
  });

  it('userIntentDelta = -x 方向（与候选同向）→ 接受候选', () => {
    const delta = computeSnapDelta(moving, staticP, ports, { userIntentDelta: [-0.008, 0, 0] });
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(-0.008, 6);
  });

  it('userIntentDelta = +z 方向（垂直于 snap delta）→ dot=0 不过滤，接受', () => {
    const delta = computeSnapDelta(moving, staticP, ports, { userIntentDelta: [0, 0, 0.008] });
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(-0.008, 6);
  });

  it('userIntentDelta = (0,0,0) → 视作无意图（手动 0 平移触发），不过滤', () => {
    const delta = computeSnapDelta(moving, staticP, ports, { userIntentDelta: [0, 0, 0] });
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(-0.008, 6);
  });
});

describe('computeSnapDelta: 法向 ±x port 也工作', () => {
  it('动件 +x 法向 ↔ 静件 -x 法向 → 给出朝 -x 的 delta', () => {
    const moving = [partAtOrigin('m', 'M')];
    const staticP = [partAt('s', 'S', [0.004, 0, 0])];
    const portFacingMinusX = (pos: [number, number, number]): SnapPortInput => ({
      position: pos,
      rotation: [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    });
    const ports = {
      M: [portFacingPlusX([0, 0, 0])],
      S: [portFacingMinusX([0, 0, 0])],
    };
    const delta = computeSnapDelta(moving, staticP, ports);
    expect(delta).not.toBeNull();
    expect(delta![0]).toBeCloseTo(0.004, 6);
  });
});

describe('computeSnapDelta: 边界 case', () => {
  it('动件没有 port（ldrawId 找不到端口）→ 返 null', () => {
    const delta = computeSnapDelta(
      [partAtOrigin('m', 'M')],
      [partAt('s', 'S', [0.004, 0, 0])],
      { S: [portFacingMinusZ([0, 0, 0])] }, // M 无端口
    );
    expect(delta).toBeNull();
  });

  it('静件为空 → 返 null', () => {
    const delta = computeSnapDelta(
      [partAtOrigin('m', 'M')],
      [],
      { M: [portFacingPlusZ([0, 0, 0])] },
    );
    expect(delta).toBeNull();
  });

  it('SNAP_SEARCH_RADIUS 与 SNAP_LOCK_THRESHOLD 是 export 常量', () => {
    expect(SNAP_SEARCH_RADIUS).toBe(0.008);
    expect(SNAP_LOCK_THRESHOLD).toBe(0.001);
  });
});

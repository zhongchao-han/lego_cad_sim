/**
 * plugSnapPredict.ts
 * ==================
 * 走法 A 期 B.3-1 — plug-snap 预测纯函数。
 *
 * 用途：用户 Shift+Click 触发 plug snap 前，前端**预计算**后端 Auto-Latch
 * 会闭合的 port 对集合，提供：
 *   - UX 预览（"snap 后将连接 N 对端口"）
 *   - 单测 oracle（不依赖后端 stub 即可验 plug-snap 整体行为）
 *   - 边界对照（若与后端 auto_latched_edges 长度不一致 → 暴露 gap）
 *
 * 后端真相源仍是 backend/auto_latch_scanner.py（1mm site 距离 + 语义筛选）。
 * 本函数是其前端**镜像**，输入是 source/target plug member 的世界坐标 +
 * portType，输出是预计配对。**贪心最近距离 + 双向唯一**：
 *   - 对每个 source member，挑距离最近且未被占的兼容 target member
 *   - 每个 target member 最多被配一次（双向 bijection 上限）
 *
 * 后端 Auto-Latch 是 site×site 嵌套循环、首个语义匹配即返；行为细节会有
 * 微小差异（同距离平手时选谁），但配对计数和拓扑结构应一致。差异交由
 * B.3-2 集成测试验证。
 *
 * 纯函数，不读 store / DOM / network。
 */

import type { Vec3 } from '../types';
import { checkFitByTypes, FitType } from './fitMath';

/** Auto-Latch 距离阈值：1mm，跟 backend/auto_latch_scanner.py
 *  AUTO_LATCH_THRESHOLD_M 同源。改一处两边同步。 */
export const AUTO_LATCH_DISTANCE_THRESHOLD = 0.001;

/**
 * plug member 的世界坐标 + 语义信息。callsite 责任：
 *   - worldPos: source 已应用 snap 后的 rigid transform；target 是 part 当前世界位姿
 *   - portType: LDraw port type 字符串，喂给 fitMath.checkFitByTypes
 *   - memberIdx: 在 plug.members 数组里的下标；用于输出透传，供 callsite
 *     拿来索引回 plug.members → ConnectionEdge
 */
export interface PortWorldInfo {
  worldPos: Vec3;
  portType: string;
  memberIdx: number;
}

/** 配对结果：source 第 i 个 member 跟 target 第 j 个 member 闭合。 */
export interface PredictedPair {
  sourceMemberIdx: number;
  targetMemberIdx: number;
  /** 米；< threshold 才会出现在结果里 */
  distance: number;
}

function distance3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 预测 plug-snap 闭合的端口对。
 *
 * @param sourceMembersWorld source plug member 列表（worldPos 已是 snap 后位置）
 * @param targetMembersWorld target plug member 列表（worldPos 是当前世界位置）
 * @param threshold 距离阈值，默认 1mm 跟后端同
 * @returns 预测配对列表；空数组表示 plug-snap 在该 transform 下无任何额外配对
 */
export function predictPlugSnapPairs(
  sourceMembersWorld: PortWorldInfo[],
  targetMembersWorld: PortWorldInfo[],
  threshold: number = AUTO_LATCH_DISTANCE_THRESHOLD,
): PredictedPair[] {
  const pairs: PredictedPair[] = [];
  const usedTargets = new Set<number>();

  for (const src of sourceMembersWorld) {
    let bestTargetIdx = -1;
    let bestDist = Infinity;
    for (const tgt of targetMembersWorld) {
      if (usedTargets.has(tgt.memberIdx)) continue;
      const d = distance3(src.worldPos, tgt.worldPos);
      if (d > threshold) continue;
      if (checkFitByTypes(src.portType, tgt.portType) === FitType.INCOMPATIBLE
          && checkFitByTypes(tgt.portType, src.portType) === FitType.INCOMPATIBLE) {
        // 两种 plug/socket 顺序都不行 → 真不兼容（极性 / profile 不对）
        continue;
      }
      if (d < bestDist) {
        bestDist = d;
        bestTargetIdx = tgt.memberIdx;
      }
    }
    if (bestTargetIdx !== -1) {
      pairs.push({
        sourceMemberIdx: src.memberIdx,
        targetMemberIdx: bestTargetIdx,
        distance: bestDist,
      });
      usedTargets.add(bestTargetIdx);
    }
  }
  return pairs;
}

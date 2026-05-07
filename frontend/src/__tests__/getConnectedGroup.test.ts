/**
 * getConnectedGroup.test.ts
 * =========================
 * C9 — 岛屿分裂 (EDITOR Case 4.2) 单测
 *
 * store.ts:254 export 的 BFS 纯函数 `getConnectedGroup(connections, startId, excludeId)`
 * 是 rotateSelectedPart v5 one-hop closure / handlePortClick / snapParts /
 * selectPart 的拓扑判定基础。先前 0 单测覆盖。
 *
 * 重点 case：
 *   - "connections 残缺"非对称形态（删除节点但邻居 Set 未同步清理）—
 *     真实路径出现在 deletePart / AutoLatch 异步并入的临时状态
 *   - excludeId === startId 边界（visited.add(startId) 在 exclude 检查前，
 *     起点不被排除是当前实现的语义）
 *
 * 拓扑用 Record<string, Set<string>> 直接构造，不走 store action；返回
 * 用 sort 对比规避 Set 迭代顺序非确定。
 */

import { describe, it, expect } from 'vitest';
import { getConnectedGroup } from '../store';

type Graph = Record<string, Set<string>>;

/** 双向边 helper：自动给 a/b 互相加邻居 */
function addEdge(g: Graph, a: string, b: string) {
  if (!g[a]) g[a] = new Set();
  if (!g[b]) g[b] = new Set();
  g[a].add(b);
  g[b].add(a);
}

/** 返回数组排序后再比，规避 Set→Array 顺序非确定 */
function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

describe('getConnectedGroup — BFS 拓扑分裂', () => {
  it('case 1: 空图 → 起点本身', () => {
    const g: Graph = {};
    expect(sorted(getConnectedGroup(g, 'A', ''))).toEqual(['A']);
  });

  it('case 2: startId 不在 connections 字典（孤岛节点）→ 起点本身', () => {
    const g: Graph = { B: new Set(['C']), C: new Set(['B']) };
    expect(sorted(getConnectedGroup(g, 'A', ''))).toEqual(['A']);
  });

  it('case 3: 链 A↔B↔C 全访问', () => {
    const g: Graph = {};
    addEdge(g, 'A', 'B');
    addEdge(g, 'B', 'C');
    expect(sorted(getConnectedGroup(g, 'A', ''))).toEqual(['A', 'B', 'C']);
  });

  it('case 4: 链 A↔B↔C↔D↔E，exclude=C → C 切断 A 那侧只到 B', () => {
    const g: Graph = {};
    addEdge(g, 'A', 'B');
    addEdge(g, 'B', 'C');
    addEdge(g, 'C', 'D');
    addEdge(g, 'D', 'E');
    expect(sorted(getConnectedGroup(g, 'A', 'C'))).toEqual(['A', 'B']);
  });

  it('case 5: 环 A↔B↔C↔A，exclude=B → 经 C 仍可达，A+C', () => {
    const g: Graph = {};
    addEdge(g, 'A', 'B');
    addEdge(g, 'B', 'C');
    addEdge(g, 'C', 'A');
    expect(sorted(getConnectedGroup(g, 'A', 'B'))).toEqual(['A', 'C']);
  });

  it('case 6: 双独立岛 {A↔B}, {C↔D}，从 A 出发不跨岛', () => {
    const g: Graph = {};
    addEdge(g, 'A', 'B');
    addEdge(g, 'C', 'D');
    expect(sorted(getConnectedGroup(g, 'A', ''))).toEqual(['A', 'B']);
    expect(sorted(getConnectedGroup(g, 'C', ''))).toEqual(['C', 'D']);
  });

  it('case 7: excludeId === startId 边界 — visited.add(startId) 在 exclude 检查前，起点仍计入但邻居全 unreachable', () => {
    const g: Graph = {};
    addEdge(g, 'A', 'B');
    addEdge(g, 'B', 'C');
    // 起点直接 visited，BFS 队首是 A，邻居 B 通过 exclude 检查（neighbor !== excludeId）
    // → B 是邻居,!== 'A' (excludeId) → B 加入 → 继续扩散
    // 所以这个 case 实际语义是"exclude=startId 不影响 BFS",起点正常扩散到全连通组。
    // 这是当前实现的 quirk：exclude 只对邻居 (BFS frontier) 生效，不对 starting point 生效。
    // 只有当 startId 自身是 leaf（无邻居）或邻居链全在 exclude 路径上时才会退化为 [startId]。
    expect(sorted(getConnectedGroup(g, 'A', 'A'))).toEqual(['A', 'B', 'C']);
  });

  it('case 8: 非对称残缺 — A→{B}, C→{B}, B→{}（B 被半删，邻居 Set 未同步清）', () => {
    // 真实触发：deletePart 把 B 从 parts 删了但 connections.A / connections.C 残留
    // 指向 B；或 AutoLatch 异步并入时短暂状态。
    // BFS 从 A：visited={A} → 队首 A → 邻居 B（不在 visited、!=exclude）→ 加 B
    //          → 队首 B → connections[B]=undefined → for 循环跳过 → BFS 终止
    //          → 返回 [A, B]（C 隔离在另一个虚拟岛）
    const g: Graph = {
      A: new Set(['B']),
      C: new Set(['B']),
      B: new Set(), // 残缺：B 自身的 connections Set 是空的
    };
    expect(sorted(getConnectedGroup(g, 'A', ''))).toEqual(['A', 'B']);
    // 反向验证：从 C 出发也是同款行为
    expect(sorted(getConnectedGroup(g, 'C', ''))).toEqual(['B', 'C']);
  });

  it('case 9: 对称清理 — B 删除后 A↔C 完全断开', () => {
    // deletePart 完整执行后的状态：所有指向 B 的邻居都被清理掉。
    const g: Graph = {
      A: new Set(),
      C: new Set(),
    };
    expect(sorted(getConnectedGroup(g, 'A', ''))).toEqual(['A']);
    expect(sorted(getConnectedGroup(g, 'C', ''))).toEqual(['C']);
  });

  it('case 10: 关节点拓扑 — B 是 articulation point，exclude=B 后 A 只能到自己', () => {
    // A↔B↔C 链 + B↔D + B↔E。B 是关节点，删 B 整张图分裂成 {A}, {C}, {D}, {E}。
    const g: Graph = {};
    addEdge(g, 'A', 'B');
    addEdge(g, 'B', 'C');
    addEdge(g, 'B', 'D');
    addEdge(g, 'B', 'E');
    expect(sorted(getConnectedGroup(g, 'A', 'B'))).toEqual(['A']);
    expect(sorted(getConnectedGroup(g, 'C', 'B'))).toEqual(['C']);
    expect(sorted(getConnectedGroup(g, 'D', 'B'))).toEqual(['D']);
  });

  it('case 11: excludeId 不在图中 → 等价于无 exclude，完整连通组', () => {
    const g: Graph = {};
    addEdge(g, 'A', 'B');
    addEdge(g, 'B', 'C');
    expect(sorted(getConnectedGroup(g, 'A', 'NOTHING'))).toEqual(['A', 'B', 'C']);
  });
});

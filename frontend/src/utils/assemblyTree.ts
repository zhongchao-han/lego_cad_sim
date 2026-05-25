/**
 * assemblyTree.ts
 * ===============
 * 把装配看成「以地基为根的树（实为图）」。移动选中件时，只动「挂在它下游、离开它
 * 就会和地基断开」的子树，祖先侧（含地基）不动。纯函数，便于单测。
 *
 * 设计语义（用户确认）：
 *   - 根 = 连通组里最靠地基（世界 bbox 底面 Y 最小）的件。只用来定根，跟件的大小
 *     无关 —— 这正是早先「最大件当地基」反直觉的修正点。
 *   - 移动 = 选中件的「子树」= 把选中件从图里拿掉后，会与根断开连接的那些件
 *     （含选中件自身）。仍能绕别的路连回根的件不属于子树，不动。
 *   - 抓住根本身（选中件含根）→ 整组都动（搬整堆）。
 */

/** 连通图：partId -> 邻居 partId 集合（无向）。 */
export type ConnGraph = Record<string, Set<string>>;

/**
 * 在连通组里挑「地基」根：heightOf 最小者（越小越靠地基，如大底板的底面）。
 * 高度相同按 id 稳定取小者。空组返 null。
 */
export function pickRootPart(comp: string[], heightOf: (id: string) => number): string | null {
  let best: string | null = null;
  let bestH = Infinity;
  for (const id of comp) {
    const h = heightOf(id);
    if (h < bestH || (h === bestH && best !== null && id < best)) {
      bestH = h;
      best = id;
    }
  }
  return best;
}

/**
 * 动件子树：移除 selectedIds 后会与 root 断开连接的件（含 selectedIds 自身）。
 *
 * - root 为空 / selectedIds 含 root → 抓住地基 → 返回整组（搬整堆）。
 * - 否则：从 root 出发、**不踏过任何 selected 节点** 做 BFS，能到达的是「祖先 +
 *   旁支」(不动)；comp 里其余的（selected + 被切断的下游）即动件子树。
 *
 * @param connections 连通图（无向邻接）
 * @param comp        选中件所在的连通分量（getConnectedGroup 的结果）
 * @param selectedIds 当前选中的件
 * @param rootId      pickRootPart 选出的根；null 视作整组都动
 */
export function computeMovingSubtree(
  connections: ConnGraph,
  comp: string[],
  selectedIds: string[],
  rootId: string | null,
): string[] {
  const selected = new Set(selectedIds);
  if (!rootId || selected.has(rootId)) return [...comp];

  const compSet = new Set(comp);
  // 从根 BFS，遇到 selected 节点不踏过（它们及其下游归动件侧）。
  const stays = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const nbrs = connections[cur];
    if (!nbrs) continue;
    for (const nb of nbrs) {
      if (!compSet.has(nb) || selected.has(nb) || stays.has(nb)) continue;
      stays.add(nb);
      queue.push(nb);
    }
  }
  return comp.filter(id => !stays.has(id));
}

/**
 * 胶水模型动件分组：连接件（销/轴/连接器，`isConnector=true`）视为「胶水」而非树节点——
 * 它依附在所粘的构件上，跟着正在移动的那侧走，以便落位后把构件重新粘上。
 *
 * 步骤：
 *   1. 把零件分成「构件」(component) 与「胶水」(connector)。
 *   2. 在**构件图**（把胶水折叠成边：A、B 之间隔着胶水也算相邻）上，算选中构件的子树
 *      `movingComponents`（移除选中构件后会与 root 断开的构件）。
 *   3. `moving = 选中件 ∪ movingComponents ∪ 粘在任一 moving 构件上的胶水`。
 *      桥接「moving 构件 ↔ 静止构件」的胶水 → 归 moving 侧（被带走，落位后重新粘），
 *      因此连续移动时它永远跟着构件走，不会被划到地基侧而把构件甩掉。
 *
 * @param rootId 必须是构件（地基）；由调用方在「构件」里挑最低者。
 */
export function computeMovingGroup(
  connections: ConnGraph,
  comp: string[],
  selectedIds: string[],
  rootId: string | null,
  isConnector: (id: string) => boolean,
): string[] {
  const compSet = new Set(comp);
  const selected = new Set(selectedIds);
  const components = comp.filter(id => !isConnector(id));
  const componentSet = new Set(components);

  // 构件邻接（穿过胶水节点直达其它构件）。
  const componentNeighbors = (a: string): Set<string> => {
    const res = new Set<string>();
    const visited = new Set<string>([a]);
    const q: string[] = [a];
    while (q.length > 0) {
      const cur = q.shift()!;
      const nbrs = connections[cur];
      if (!nbrs) continue;
      for (const nb of nbrs) {
        if (!compSet.has(nb) || visited.has(nb)) continue;
        if (componentSet.has(nb)) {
          res.add(nb);               // 构件邻居：记录，不穿过它
        } else {
          visited.add(nb);
          q.push(nb);                // 胶水：穿过去继续找构件
        }
      }
    }
    return res;
  };
  const componentGraph: ConnGraph = {};
  for (const c of components) componentGraph[c] = componentNeighbors(c);

  // 选中件里属于构件的；若只选了胶水，movingComponents 为空、只动选中件本身。
  const selectedComponents = components.filter(id => selected.has(id));
  const movingComponents = selectedComponents.length > 0
    ? computeMovingSubtree(componentGraph, components, selectedComponents, rootId)
    : [];
  const movingCompSet = new Set(movingComponents);

  const moving = new Set<string>(selectedIds);
  movingComponents.forEach(id => moving.add(id));
  // 粘在任一 moving 构件上的胶水 → 跟着走（哪怕它另一头桥到静止构件）。
  for (const id of comp) {
    if (!isConnector(id)) continue;
    const nbrs = connections[id];
    if (!nbrs) continue;
    for (const nb of nbrs) {
      if (movingCompSet.has(nb)) { moving.add(id); break; }
    }
  }
  return [...moving];
}

/**
 * pickPlugAnchor.ts
 * =================
 * 走法 A 期 B.2 — plug-level 选中时挑"锚点 port"。
 *
 * 启发式（两步）：
 *   1. 过滤同方向 member — plug 跨双面时（贯通孔合并的顶/底两组），只挑跟
 *      用户点中那一面（clickedPort.rotation）方向相同的 member。直观语义：
 *      "Shift+Click 顶面孔 → 落在顶面中心，不会跳到底面"
 *   2. 重心最近 — 同方向 member 内取几何重心，挑距重心最近的 member 作 anchor
 *
 * 退化路径：
 *   - 单 port plug → 自身
 *   - clickedPort 无 plug_id / 装饰类 → 返 clickedPort 不动
 *   - plug.members 在 sites 里查不到 → 返 clickedPort 不动
 *
 * 同方向过滤副效果：anchor 跟 clicked port 共享 rotation 矩阵 → globalQuat
 * 无需重算（part 刚体姿态没变，局部 rotation 也没变）。
 *
 * 纯函数，不读 store / 相机 / DOM。
 */

import type { LDrawSite, LDrawPort, LDrawPlug } from '../useLDrawPart';
import type { SelectedPortInfo, Vec3, Mat3 } from '../types';
import { checkFitByTypes, FitType } from './fitMath';

const ROT_EPS = 1e-4;

/** Mat3 在 types.ts 是 `number[][] | number[]` 联合（运行时形状取决于
 *  来源）。从 ldraw_port_configs.json / 后端 baked 出来的 port.rotation
 *  始终是 3x3 nested。此函数仅在 nested 形式下比较，flat 形式直接返
 *  false（视为不匹配）— callsite 用 plug member.rotation，全是 nested。 */
function rotationsEqual(a: number[][] | number[], b: number[][] | number[]): boolean {
  if (!Array.isArray(a[0]) || !Array.isArray(b[0])) return false;
  const aa = a as number[][];
  const bb = b as number[][];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (Math.abs(aa[i][j] - bb[i][j]) > ROT_EPS) return false;
    }
  }
  return true;
}

function buildPortLookup(sites: LDrawSite[]): Map<string, LDrawPort> {
  const m = new Map<string, LDrawPort>();
  for (const site of sites) {
    site.ports.forEach((port, idx) => {
      m.set(`${site.id}|${idx}`, port);
    });
  }
  return m;
}

function distance3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 在 plug.members 里挑 anchor — 先过滤同方向 member，再取重心最近者。
 *
 * @param plug plug 元数据
 * @param sites 用于 (site_id, port_idx) → port 解析
 * @param clickedRotation 用户点中的 port 的 rotation 矩阵，用于同方向过滤
 * @returns anchor port，或 null 若 plug 无可用 member
 */
export function findAnchorMember(
  plug: LDrawPlug,
  sites: LDrawSite[],
  clickedRotation: number[][] | number[],
): LDrawPort | null {
  if (plug.members.length === 0) return null;
  const lookup = buildPortLookup(sites);

  const sameDirection: LDrawPort[] = [];
  for (const [siteId, portIdx] of plug.members) {
    const port = lookup.get(`${siteId}|${portIdx}`);
    if (!port) continue;
    if (rotationsEqual(port.rotation, clickedRotation)) {
      sameDirection.push(port);
    }
  }
  if (sameDirection.length === 0) return null;
  if (sameDirection.length === 1) return sameDirection[0];

  const cx = sameDirection.reduce((s, p) => s + p.position[0], 0) / sameDirection.length;
  const cy = sameDirection.reduce((s, p) => s + p.position[1], 0) / sameDirection.length;
  const cz = sameDirection.reduce((s, p) => s + p.position[2], 0) / sameDirection.length;
  const centroid: Vec3 = [cx, cy, cz];

  let best = sameDirection[0];
  let bestDist = distance3(best.position, centroid);
  for (let i = 1; i < sameDirection.length; i++) {
    const d = distance3(sameDirection[i].position, centroid);
    if (d < bestDist) {
      best = sameDirection[i];
      bestDist = d;
    }
  }
  return best;
}

/**
 * 主入口：Shift+Click 时算"PLUG 模式下要记录哪个 port 当 selectedPort"。
 *
 * **更新（bug fix）**：原 "重心 anchor" 启发式被用户实际测试推翻 — 用户
 * 点 plug 端点期望 source 是该端点，但 anchor 跳到重心可能位移 4 个孔位
 * (32mm)，下次 snap 走的轴跟点击意图错位。
 *
 * 现在改为 "**原位 anchor**"：直接返 clickedPort，仅补 `plug_port_count`
 * 让 B.3-extension 预览上界能算。Plug 视觉整片高亮（B.2 ACTIVE_COLOR）
 * 仍正常 — 跟 plug member 集合相关，跟 selectedPort 落在哪颗无关。
 *
 * 保留 `findAnchorMember` 不导出移除 — 它仍被单测复用，未来若需要
 * 重新引入 anchor 策略（比如基于相机视线挑面对用户的那颗）可直接用。
 *
 * Degenerate 路径（不进 anchor 改造）：
 *   - clickedPort 无 plug_id → 装饰类零件，直接返 clickedPort 不动
 *   - plug 查不到（数据不同步）→ 返 clickedPort 不动
 */
export function pickPlugAnchorPort(
  clickedPort: SelectedPortInfo,
  plugs: LDrawPlug[],
  // sites 参数保留，签名稳定 — 未来若启发式回来要用
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sites: LDrawSite[],
): SelectedPortInfo {
  if (!clickedPort.plug_id) return clickedPort;
  const plug = plugs.find(p => p.plug_id === clickedPort.plug_id);
  if (!plug) return clickedPort;

  // "原位 anchor"：直接复用 clickedPort，仅补 plug_port_count
  return { ...clickedPort, plug_port_count: plug.port_count };
}

/**
 * B.3-extension：pre-commit 预览上界。
 *
 * 给"用户已 PLUG-locked source + hover target plug"算预计闭合 pair 数：
 *   min(sourcePortCount, targetPortCount)，前提是 sourcePortType ↔
 *   targetPortType 兼容（gender + profile）。
 *
 * 上界（不精确）：实际 Auto-Latch 会按 1mm 几何阈值筛；如果 plug 之间几何
 * 错位，commit 后可能少于 min。UX 上 "Will snap **up to** N pairs" 措辞
 * 让用户对偏差有预期。
 *
 * 返 null 表示无预测（缺源 plug 上下文 / 不兼容 / plug_id 缺）；callsite
 * 据此判定是否显示。
 */
export function predictPlugSnapUpperBound(args: {
  sourcePortType?: string;
  sourcePlugPortCount?: number;
  targetPortType?: string;
  targetPlugPortCount?: number;
}): number | null {
  const { sourcePortType, sourcePlugPortCount, targetPortType, targetPlugPortCount } = args;
  if (!sourcePortType || !targetPortType) return null;
  if (sourcePlugPortCount === undefined || targetPlugPortCount === undefined) return null;
  if (sourcePlugPortCount <= 0 || targetPlugPortCount <= 0) return null;
  // 双向 fit 试（plug/socket 顺序敏感，端口实例可能任意极性）
  const fitA = checkFitByTypes(sourcePortType, targetPortType);
  const fitB = checkFitByTypes(targetPortType, sourcePortType);
  if (fitA === FitType.INCOMPATIBLE && fitB === FitType.INCOMPATIBLE) return null;
  return Math.min(sourcePlugPortCount, targetPlugPortCount);
}

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
 * 主入口：算 anchor port 对应的 SelectedPortInfo。
 *   - clickedPort 无 plug_id / plug 查不到 / anchor 等于 clicked → 返 clickedPort
 *   - 否则返 anchor 的 SelectedPortInfo（partId / ldrawId / globalQuat /
 *     globalPos 都按 part 刚体平移 / 同 rotation 推算）
 */
export function pickPlugAnchorPort(
  clickedPort: SelectedPortInfo,
  plugs: LDrawPlug[],
  sites: LDrawSite[],
): SelectedPortInfo {
  if (!clickedPort.plug_id) return clickedPort;
  const plug = plugs.find(p => p.plug_id === clickedPort.plug_id);
  if (!plug) return clickedPort;

  const anchor = findAnchorMember(plug, sites, clickedPort.rotation);
  if (!anchor) return clickedPort;

  // anchor === clicked（按 position 比较）→ 不构造新对象，节省一次 commit
  if (
    Math.abs(anchor.position[0] - clickedPort.position[0]) < ROT_EPS
    && Math.abs(anchor.position[1] - clickedPort.position[1]) < ROT_EPS
    && Math.abs(anchor.position[2] - clickedPort.position[2]) < ROT_EPS
  ) {
    return clickedPort;
  }

  // anchor 跟 clicked 同 part 刚体 + 同 rotation → globalQuat 不变；
  // globalPos 按局部位移平移（局部位移 = 世界位移，刚体前提）
  const dx = anchor.position[0] - clickedPort.position[0];
  const dy = anchor.position[1] - clickedPort.position[1];
  const dz = anchor.position[2] - clickedPort.position[2];

  return {
    partId: clickedPort.partId,
    ldrawId: clickedPort.ldrawId,
    portType: anchor.type,
    position: anchor.position as Vec3,
    rotation: anchor.rotation as Mat3,
    globalPos: [
      clickedPort.globalPos[0] + dx,
      clickedPort.globalPos[1] + dy,
      clickedPort.globalPos[2] + dz,
    ],
    globalQuat: clickedPort.globalQuat,
    plug_id: clickedPort.plug_id,
    isFromPreview: clickedPort.isFromPreview,
  };
}

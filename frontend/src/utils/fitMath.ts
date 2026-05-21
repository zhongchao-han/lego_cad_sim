/**
 * fitMath.ts — L46 物理过盈反馈
 * ================================
 * 后端 backend/port_semantics.py 的前端轻量复刻。AXIAL_SLIDING 是高频按键
 * 输入路径，每按一次方向键都查 fit；用 /api/check_fit 来回 round-trip 太慢，
 * 直接复制接口表 + check_fit 逻辑到前端。
 *
 * 同步约束：本表必须与 backend/port_semantics.py INTERFACE_REGISTRY 对齐。
 * 后端有变更（加新 port 类型 / 改半径）时本文件需要同步。配套单测断言核心
 * 配对（pin↔peghole=CLEARANCE / fric_pin↔peghole=FRICTION）正确，drift
 * 的话 CI 上能立刻报警。
 */

// ─── 常量（与 backend/port_semantics.py 同源）───────────────────────────────
const LDU_M = 0.0004; // 1 LDU = 0.4mm
const DELTA_FRICTION_MAX_M = 0.0003; // 0.3mm 以内为摩擦/过盈

// ─── 枚举 ─────────────────────────────────────────────────────────────────
export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
}

export enum Profile {
  CYLINDER = 'CYLINDER',
  CROSS = 'CROSS',
  STUD = 'STUD',
}

export enum FitType {
  CLEARANCE = 'clearance',
  FRICTION = 'friction',
  INTERFERENCE = 'interference',
  BLOCKED = 'blocked',
  INCOMPATIBLE = 'incompatible',
}

export interface ConnectionInterface {
  gender: Gender;
  profile: Profile;
  /** SI meters；销/孔的有效半径 */
  radius: number;
  /** SI meters */
  depth: number;
}

const _f = (gender: Gender, profile: Profile, rLDU: number, dLDU: number): ConnectionInterface => ({
  gender, profile, radius: rLDU * LDU_M, depth: dLDU * LDU_M,
});

// ─── 接口注册表（与 backend INTERFACE_REGISTRY 同源）────────────────────────
const INTERFACE_REGISTRY: Record<string, ConnectionInterface> = {
  // FEMALE 圆孔
  'peghole':         _f(Gender.FEMALE, Profile.CYLINDER, 6.0, 20.0),
  'peghole.dat':     _f(Gender.FEMALE, Profile.CYLINDER, 6.0, 20.0),
  'beamhole.dat':    _f(Gender.FEMALE, Profile.CYLINDER, 6.0, 20.0),
  'connhole.dat':    _f(Gender.FEMALE, Profile.CYLINDER, 6.0, 20.0),
  'connhol.dat':     _f(Gender.FEMALE, Profile.CYLINDER, 6.0, 20.0),
  'npeghol.dat':     _f(Gender.FEMALE, Profile.CYLINDER, 6.0, 20.0),
  'axleholepin.dat': _f(Gender.FEMALE, Profile.CYLINDER, 6.0, 20.0),

  // FEMALE 十字轴孔
  'axlehole':     _f(Gender.FEMALE, Profile.CROSS, 4.0, 20.0),
  'axlehole.dat': _f(Gender.FEMALE, Profile.CROSS, 4.0, 20.0),

  // MALE 普通销（间隙配合）
  'peg':       _f(Gender.MALE, Profile.CYLINDER, 5.9, 40.0),
  'peg.dat':   _f(Gender.MALE, Profile.CYLINDER, 5.9, 40.0),
  'pin':       _f(Gender.MALE, Profile.CYLINDER, 5.9, 40.0),
  'pin.dat':   _f(Gender.MALE, Profile.CYLINDER, 5.9, 40.0),
  'halfpin.dat':   _f(Gender.MALE, Profile.CYLINDER, 5.9, 20.0),
  'connect.dat':   _f(Gender.MALE, Profile.CYLINDER, 5.9, 20.0),

  // MALE 摩擦销
  'fric_pin.dat':  _f(Gender.MALE, Profile.CYLINDER, 6.2, 40.0),
  'pin_friction':  _f(Gender.MALE, Profile.CYLINDER, 6.2, 40.0),
  'confric3.dat':  _f(Gender.MALE, Profile.CYLINDER, 6.2, 20.0),
  'confric5.dat':  _f(Gender.MALE, Profile.CYLINDER, 6.2, 20.0),
  'confric6.dat':  _f(Gender.MALE, Profile.CYLINDER, 6.2, 40.0),
  'confric8.dat':  _f(Gender.MALE, Profile.CYLINDER, 6.2, 40.0),

  // MALE 十字轴
  'axle':     _f(Gender.MALE, Profile.CROSS, 3.9, 40.0),
  'axle.dat': _f(Gender.MALE, Profile.CROSS, 3.9, 40.0),

  // STUD pair（用于乐高凸起）
  'stud':       _f(Gender.MALE, Profile.STUD, 6.0, 4.0),
  'stud.dat':   _f(Gender.MALE, Profile.STUD, 6.0, 4.0),
  'stud2.dat':  _f(Gender.MALE, Profile.STUD, 6.0, 4.0),
  'stud3.dat':  _f(Gender.MALE, Profile.STUD, 6.0, 4.0),
  'stud4.dat':  _f(Gender.MALE, Profile.STUD, 6.0, 4.0),
  'stud10.dat': _f(Gender.MALE, Profile.STUD, 6.0, 4.0),
  'tube':       _f(Gender.FEMALE, Profile.STUD, 6.0, 4.0),
  'tube.dat':   _f(Gender.FEMALE, Profile.STUD, 6.0, 4.0),
  'tube2.dat':  _f(Gender.FEMALE, Profile.STUD, 6.0, 4.0),
  'tube10.dat': _f(Gender.FEMALE, Profile.STUD, 6.0, 4.0),
};

// 前缀模糊匹配（与 backend get_interface 同序）
const _PREFIX_FALLBACKS = [
  'axlehole', 'peghole', 'beamhole', 'connhole', 'npeghol',
  'connhol', 'stud', 'tube', 'pin', 'axle', 'peg',
];

/** 后端 get_interface 同语义：精确 → 去 .dat → 前缀模糊。找不到返 null。 */
export function getInterface(portType: string): ConnectionInterface | null {
  if (!portType) return null;
  const t = portType.toLowerCase().trim();
  if (t in INTERFACE_REGISTRY) return INTERFACE_REGISTRY[t];
  const base = t.replace(/\.dat$/, '');
  if (base in INTERFACE_REGISTRY) return INTERFACE_REGISTRY[base];
  for (const prefix of _PREFIX_FALLBACKS) {
    if (base.startsWith(prefix)) {
      if (prefix in INTERFACE_REGISTRY) return INTERFACE_REGISTRY[prefix];
      const k = `${prefix}.dat`;
      if (k in INTERFACE_REGISTRY) return INTERFACE_REGISTRY[k];
    }
  }
  return null;
}

/** 后端 check_fit 同语义：极性 + 截面 + 半径差判定。
 *
 *  截面兼容：相同 profile OK；额外放行 CROSS plug 穿 CYLINDER socket（十字轴
 *  插圆孔自由旋转，issue #50）。反向 CYLINDER→CROSS 仍不兼容。改这里务必同步
 *  backend/port_semantics.py check_fit（fitMath 是其前端复刻）。 */
export function checkFit(
  plug: ConnectionInterface,
  socket: ConnectionInterface,
): FitType {
  if (plug.gender !== Gender.MALE || socket.gender !== Gender.FEMALE) {
    return FitType.INCOMPATIBLE;
  }
  const profileCompatible =
    plug.profile === socket.profile
    || (plug.profile === Profile.CROSS && socket.profile === Profile.CYLINDER);
  if (!profileCompatible) {
    return FitType.INCOMPATIBLE;
  }
  const delta = plug.radius - socket.radius;
  if (delta <= 0) return FitType.CLEARANCE;
  if (delta <= DELTA_FRICTION_MAX_M) return FitType.FRICTION;
  return FitType.BLOCKED;
}

/** 便捷：直接用两个 portType 字符串得 FitType。任一无法识别 → INCOMPATIBLE。
 *  注意 plug/socket 顺序敏感：plug 必须 MALE。一般传 (sourcePort, targetPort) 时
 *  需要根据实际极性调用方决定哪个当 plug —— 见下面的 fitForSlide() 包装。 */
export function checkFitByTypes(
  plugType: string,
  socketType: string,
): FitType {
  const plug = getInterface(plugType);
  const socket = getInterface(socketType);
  if (!plug || !socket) return FitType.INCOMPATIBLE;
  return checkFit(plug, socket);
}

/**
 * AXIAL_SLIDING 场景：source / target 极性可能任意（snap 时已经互补），
 * 自动选 MALE 当 plug，FEMALE 当 socket，再过 checkFit。
 */
export function fitForSlide(typeA: string, typeB: string): FitType {
  const a = getInterface(typeA);
  const b = getInterface(typeB);
  if (!a || !b) return FitType.INCOMPATIBLE;
  if (a.gender === Gender.MALE && b.gender === Gender.FEMALE) return checkFit(a, b);
  if (b.gender === Gender.MALE && a.gender === Gender.FEMALE) return checkFit(b, a);
  return FitType.INCOMPATIBLE;
}

// ─── 步长缩放：FitType → AXIAL_SLIDING 步长倍率 ───────────────────────────
/**
 * 把 FitType 映射为 AXIAL_SLIDING 步长缩放因子。
 *   CLEARANCE → 1.0   原始步长 (无阻力)
 *   FRICTION  → 0.25  4 倍按键才走原 1 LDU (体感"卡")
 *   INTERFERENCE → 0.1 极卡（当前 backend 把 INTERFERENCE 合到 FRICTION，
 *                      此分支预留给后续 backend 分档）
 *   BLOCKED / INCOMPATIBLE → 0    锁死，无法移动
 *   未知 fallback → 1.0
 *
 * Shift 修饰键的 10× 倍率由调用方 *外* 加，与本因子相乘。
 */
export function getSlideStepFactor(fit: FitType): number {
  switch (fit) {
    case FitType.CLEARANCE: return 1.0;
    case FitType.FRICTION: return 0.25;
    case FitType.INTERFERENCE: return 0.1;
    case FitType.BLOCKED:
    case FitType.INCOMPATIBLE:
      return 0;
    default: return 1.0;
  }
}

/** 给 StatusBar 用的人类可读标签（含 emoji）。 */
export function fitDisplayLabel(fit: FitType): string {
  switch (fit) {
    case FitType.CLEARANCE:    return '⚪ Loose';
    case FitType.FRICTION:     return '🟡 Friction';
    case FitType.INTERFERENCE: return '🔴 Interference';
    case FitType.BLOCKED:      return '⛔ Blocked';
    case FitType.INCOMPATIBLE: return '❌ Incompatible';
  }
}

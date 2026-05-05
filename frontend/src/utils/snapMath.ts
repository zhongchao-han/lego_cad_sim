import * as THREE from 'three';

/**
 * 沿轴滑动时的物理限位计算 (Collision Clamping)
 * TS-6.3: 携带 shiftKey 能够无视物理限位直接穿模
 */
export function calculateClampedOffset(offset: number, shiftKey: boolean, limit: number = 20 * 0.4): number {
    if (shiftKey) return offset; // Shift 键屏蔽物理碰撞和限位
    return Math.max(-limit, Math.min(limit, offset));
}

// ─── L54 对象池：模块级 scratch ────────────────────────────────────────────
// 这里的所有 THREE 对象都被三个 export 函数复用，避免在
// AXIAL_SLIDING / 旋转 / Snap 这种 60Hz+ 的热路径上每帧 new 出十几个
// Matrix4/Vector3/Quaternion 触发 GC 尖刺。
//
// 复用安全前提：JS 单线程 + 三个函数都是同步、非递归、返回前不持有 scratch 引用。
// store.ts 中存在 calculateSnapPose → applyGroupDelta 顺序调用，但函数之间
// scratch 完全隔离（_csp_* / _agd_* / _prp_* 命名前缀）。

const _SCALE_ONE = new THREE.Vector3(1, 1, 1);

// calculateSnapPose 专用
const _csp_mTarget = new THREE.Matrix4();
const _csp_mSourceLocal = new THREE.Matrix4();
const _csp_mPart = new THREE.Matrix4();
const _csp_mTmp = new THREE.Matrix4();
const _csp_mFlip = new THREE.Matrix4().makeRotationX(Math.PI); // 全局常量，不再每次重算
const _csp_mOffset = new THREE.Matrix4();
const _csp_vIn = new THREE.Vector3();
const _csp_qIn = new THREE.Quaternion();
const _csp_vOut = new THREE.Vector3();
const _csp_qOut = new THREE.Quaternion();
const _csp_sOut = new THREE.Vector3();

/**
 * 核心对齐算法 (Point-to-Point Snap Engine)
 * 目标：将 Source 端口 重合于 Target 端口，且 Z 轴对扣，主轴（Y/X）对齐平滑。
 *
 * @param sourcePortPos    来源端口（插销上那个）在当前零件局部坐标下的位置
 * @param sourcePortQuat   来源端口在当前零件局部坐标下的旋转
 * @param targetPortPos    目标端口（梁上那个）在组装场景下的全局位置
 * @param targetPortQuat   目标端口在组装场景下的全局旋转
 * @returns { position: Vector3 数组, quaternion: Quaternion 数组 } 零件落位的全局位姿
 */
export function calculateSnapPose(
    sourcePortPos: [number, number, number],
    sourcePortQuat: [number, number, number, number],
    targetPortPos: [number, number, number],
    targetPortQuat: [number, number, number, number],
    slideOffset: number = 0
) {
    // 1. 构造 Target 端口的全局矩阵
    _csp_mTarget.compose(
        _csp_vIn.set(targetPortPos[0], targetPortPos[1], targetPortPos[2]),
        _csp_qIn.set(targetPortQuat[0], targetPortQuat[1], targetPortQuat[2], targetPortQuat[3]),
        _SCALE_ONE,
    );

    // 2. 构造 Source 端口在零件局部坐标系下的矩阵
    _csp_mSourceLocal.compose(
        _csp_vIn.set(sourcePortPos[0], sourcePortPos[1], sourcePortPos[2]),
        _csp_qIn.set(sourcePortQuat[0], sourcePortQuat[1], sourcePortQuat[2], sourcePortQuat[3]),
        _SCALE_ONE,
    );

    // 3. 核心物理变换：M_part = T_target * T_flip * T_source_local^-1
    // 注意：Matrix4.invert() 是 in-place 操作，调用后 _csp_mSourceLocal 自身
    // 变成它的逆。下面 slideOffset 分支必须直接复用这个已 inverted 的矩阵 ——
    // 不能再 .invert() 一次（连发两次等价于不调，乘进 m_part 的实际是 S 而非
    // inv(S)，源 part 落点会偏 16 LDU 量级；pre-existing bug，已修）。
    _csp_mPart.copy(_csp_mTarget).multiply(_csp_mFlip).multiply(_csp_mSourceLocal.invert());

    // 4. 沿轴滑动 (Axial Sliding) —— 偏移在对齐后的 Source 端口 Z 轴上
    if (slideOffset !== 0) {
        _csp_mOffset.makeTranslation(0, 0, slideOffset);
        _csp_mTmp.copy(_csp_mTarget).multiply(_csp_mFlip).multiply(_csp_mOffset);
        // _csp_mSourceLocal 上一行已被 inverted；直接乘，不再 .invert()。
        _csp_mPart.copy(_csp_mTmp).multiply(_csp_mSourceLocal);
    }

    _csp_mPart.decompose(_csp_vOut, _csp_qOut, _csp_sOut);

    return {
        position: [_csp_vOut.x, _csp_vOut.y, _csp_vOut.z] as [number, number, number],
        quaternion: [_csp_qOut.x, _csp_qOut.y, _csp_qOut.z, _csp_qOut.w] as [number, number, number, number],
    };
}

/**
 * 单个零件的位姿描述（与 PartState 兼容子集）。
 */
export interface RigidPose {
    position:   [number, number, number];
    quaternion: [number, number, number, number];
}

// applyGroupDelta 专用
const _agd_mOldSrc = new THREE.Matrix4();
const _agd_mNewSrc = new THREE.Matrix4();
const _agd_mDelta = new THREE.Matrix4();
const _agd_mPart = new THREE.Matrix4();
const _agd_mPartNew = new THREE.Matrix4();
const _agd_vIn = new THREE.Vector3();
const _agd_qIn = new THREE.Quaternion();
const _agd_vOut = new THREE.Vector3();
const _agd_qOut = new THREE.Quaternion();
const _agd_sOut = new THREE.Vector3();

/**
 * 把 source 零件的"位姿位移"作为刚体 delta，整体施加给它所在的连通组里的每一个零件。
 *
 * delta = T_new × T_old⁻¹；对组内每个零件 P 应用：T_P_new = delta × T_P_old
 *
 * 用于 Snap 时让"灰板 + 已经插上的销"作为整体跟随被吸附的销飞到目标孔，
 * 而不是只把销自己拽走、把板子留在原地。
 *
 * @param srcGroup    包含 source 在内的整组 partId 列表（target 不应包含在内）
 * @param parts       当前 parts 字典，提供组内每个零件的当前 pose
 * @param sourceId    source.partId
 * @param oldSource   source 当前 pose（如果 source 是新建零件，传 identity 即可）
 * @param newSource   source 目标 pose（calculateSnapPose 的输出）
 * @returns 组内每个零件的新 pose（含 source 自身）
 */
export function applyGroupDelta(
    srcGroup: string[],
    parts: Record<string, RigidPose>,
    sourceId: string,
    oldSource: RigidPose,
    newSource: RigidPose,
): Record<string, RigidPose> {
    _agd_mOldSrc.compose(
        _agd_vIn.set(oldSource.position[0], oldSource.position[1], oldSource.position[2]),
        _agd_qIn.set(oldSource.quaternion[0], oldSource.quaternion[1], oldSource.quaternion[2], oldSource.quaternion[3]),
        _SCALE_ONE,
    );
    _agd_mNewSrc.compose(
        _agd_vIn.set(newSource.position[0], newSource.position[1], newSource.position[2]),
        _agd_qIn.set(newSource.quaternion[0], newSource.quaternion[1], newSource.quaternion[2], newSource.quaternion[3]),
        _SCALE_ONE,
    );
    // delta = m_new × m_old⁻¹
    _agd_mDelta.copy(_agd_mNewSrc).multiply(_agd_mOldSrc.invert());

    const result: Record<string, RigidPose> = {};
    srcGroup.forEach(pid => {
        if (pid === sourceId) {
            result[pid] = newSource;
            return;
        }
        const p = parts[pid];
        if (!p) return;

        _agd_mPart.compose(
            _agd_vIn.set(p.position[0], p.position[1], p.position[2]),
            _agd_qIn.set(p.quaternion[0], p.quaternion[1], p.quaternion[2], p.quaternion[3]),
            _SCALE_ONE,
        );
        _agd_mPartNew.copy(_agd_mDelta).multiply(_agd_mPart);
        _agd_mPartNew.decompose(_agd_vOut, _agd_qOut, _agd_sOut);
        result[pid] = {
            position:   [_agd_vOut.x, _agd_vOut.y, _agd_vOut.z],
            quaternion: [_agd_qOut.x, _agd_qOut.y, _agd_qOut.z, _agd_qOut.w],
        };
    });
    return result;
}

// calculatePortRotationPose 专用
const _prp_mPart = new THREE.Matrix4();
const _prp_mPortLocal = new THREE.Matrix4();
const _prp_mPortGlobal = new THREE.Matrix4();
const _prp_mRotZ = new THREE.Matrix4();
const _prp_mPartNew = new THREE.Matrix4();
const _prp_vIn = new THREE.Vector3();
const _prp_qIn = new THREE.Quaternion();
const _prp_vOut = new THREE.Vector3();
const _prp_qOut = new THREE.Quaternion();
const _prp_sOut = new THREE.Vector3();

/**
 * 沿指定端口的 Z 轴（法线）旋转整个零件
 */
export function calculatePortRotationPose(
    partPos: [number, number, number],
    partQuat: [number, number, number, number],
    portLocalPos: [number, number, number],
    portLocalQuat: [number, number, number, number],
    angleRads: number
) {
    _prp_mPart.compose(
        _prp_vIn.set(partPos[0], partPos[1], partPos[2]),
        _prp_qIn.set(partQuat[0], partQuat[1], partQuat[2], partQuat[3]),
        _SCALE_ONE,
    );
    _prp_mPortLocal.compose(
        _prp_vIn.set(portLocalPos[0], portLocalPos[1], portLocalPos[2]),
        _prp_qIn.set(portLocalQuat[0], portLocalQuat[1], portLocalQuat[2], portLocalQuat[3]),
        _SCALE_ONE,
    );

    // 端口的当前全局矩阵
    _prp_mPortGlobal.copy(_prp_mPart).multiply(_prp_mPortLocal);

    // 在端口自身局部坐标系下绕 Z 轴旋转
    _prp_mRotZ.makeRotationZ(angleRads);
    _prp_mPortGlobal.multiply(_prp_mRotZ);

    // 反推零件的新全局矩阵：m_part_new = m_port_new × m_port_local^-1
    // 注意：_prp_mPortLocal.invert() 是 in-place；本函数后续不再读它，所以安全。
    _prp_mPartNew.copy(_prp_mPortGlobal).multiply(_prp_mPortLocal.invert());
    _prp_mPartNew.decompose(_prp_vOut, _prp_qOut, _prp_sOut);

    return {
        position: [_prp_vOut.x, _prp_vOut.y, _prp_vOut.z] as [number, number, number],
        quaternion: [_prp_qOut.x, _prp_qOut.y, _prp_qOut.z, _prp_qOut.w] as [number, number, number, number],
    };
}

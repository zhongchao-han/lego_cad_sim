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

// Roll preservation 专用 scratch（swing-twist 分解 + 修正后的 part quat 重组）
const _csp_qNaive = new THREE.Quaternion();
const _csp_qCurrent = new THREE.Quaternion();
const _csp_qDelta = new THREE.Quaternion();
const _csp_qTwist = new THREE.Quaternion();
const _csp_vPortZ = new THREE.Vector3();

/**
 * 核心对齐算法 (Point-to-Point Snap Engine)
 * 目标：将 Source 端口 重合于 Target 端口，且 Z 轴对扣，主轴（Y/X）对齐平滑。
 *
 * @param sourcePortPos    来源端口（插销上那个）在当前零件局部坐标下的位置
 * @param sourcePortQuat   来源端口在当前零件局部坐标下的旋转
 * @param targetPortPos    目标端口（梁上那个）在组装场景下的全局位置
 * @param targetPortQuat   目标端口在组装场景下的全局旋转
 * @param slideOffset      沿轴滑动偏移（单位米）
 * @param sourcePartCurrentWorldQuat
 *   可选；source 零件**当前**世界 quat。提供后，snap 会做 swing-twist 分解：
 *   端口法向（z 轴）对扣是硬约束，但绕端口轴的 roll **自由旋转**，从这一族合
 *   法旋转里挑跟"当前姿态"最接近的那个 → source 群组**只平移、不无谓翻跟头**。
 *   不提供时回退到老行为（始终乘 T_flip=Rx(180°)，roll 固定为 0）。
 *
 * @returns { position, quaternion } 零件落位的全局位姿
 */
export function calculateSnapPose(
    sourcePortPos: [number, number, number],
    sourcePortQuat: [number, number, number, number],
    targetPortPos: [number, number, number],
    targetPortQuat: [number, number, number, number],
    slideOffset: number = 0,
    sourcePartCurrentWorldQuat?: [number, number, number, number],
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

    // 5. （可选）Roll 修正：让 source 群组只平移、不绕端口轴无端翻跟头。
    //
    // 背景：上面公式硬乘 T_flip = Rx(180°)，等价于"绕端口轴自转角 = 0"这个
    //   武断选择。但端口对扣的物理约束只锁端口 z 轴方向（法向），**绕该轴的
    //   roll 是自由变量**。原算法浪费这个自由度，导致一旦 source 当前姿态的
    //   roll ≠ 0，snap 会把整个 source 群组绕端口位置自转 → 转盘飞、用户懵。
    //
    // 修法：swing-twist 分解
    //   1. q_naive = 上面算出的 _csp_qOut（"roll=0 选择"下的 source part quat）
    //   2. q_current = sourcePartCurrentWorldQuat（用户视觉里的"现姿态"）
    //   3. q_delta = q_current × inv(q_naive)（从 naive 到 current 的整旋转）
    //   4. 把 q_delta 投影到"绕端口轴"的 twist 分量 + 剩下垂直的 swing 分量
    //   5. 只保留 twist：q_final = twist × q_naive
    //      — 这保证 q_final × sourcePortQuat 的 z 轴 = q_naive × sourcePortQuat 的 z 轴
    //        （端口法向不动），同时绕端口轴的角度尽量贴近 q_current。
    //
    // 不传 sourcePartCurrentWorldQuat 时跳过该步，与原 API 完全兼容。
    if (sourcePartCurrentWorldQuat) {
        _csp_qNaive.copy(_csp_qOut);
        _csp_qCurrent.set(
            sourcePartCurrentWorldQuat[0],
            sourcePartCurrentWorldQuat[1],
            sourcePartCurrentWorldQuat[2],
            sourcePartCurrentWorldQuat[3],
        );

        // 端口轴（世界系）：naive snap 后 source 零件本地端口 +z 在世界的方向
        // = q_naive × q_portLocal_z = q_naive × q_sourcePortQuat × (0,0,1)
        _csp_qIn.set(sourcePortQuat[0], sourcePortQuat[1], sourcePortQuat[2], sourcePortQuat[3]);
        _csp_vPortZ.set(0, 0, 1).applyQuaternion(_csp_qIn).applyQuaternion(_csp_qNaive).normalize();

        // q_delta = q_current × inv(q_naive)，把 q_naive "旋"成 q_current 的整旋转
        _csp_qDelta.copy(_csp_qNaive).invert().premultiply(_csp_qCurrent);

        // swing-twist 分解：twist = 绕 _csp_vPortZ 的分量（quat 的 vector 部投影到轴）
        const dot = _csp_qDelta.x * _csp_vPortZ.x
                  + _csp_qDelta.y * _csp_vPortZ.y
                  + _csp_qDelta.z * _csp_vPortZ.z;
        _csp_qTwist.set(
            _csp_vPortZ.x * dot,
            _csp_vPortZ.y * dot,
            _csp_vPortZ.z * dot,
            _csp_qDelta.w,
        );
        // 退化：q_delta 沿端口轴几乎无分量（dot≈0 且 w≈0）→ twist 范数趋零，
        // 不归一化会得到 NaN。此时 twist = identity（不旋转），不破坏 naive 解。
        const tLen = Math.sqrt(_csp_qTwist.x * _csp_qTwist.x + _csp_qTwist.y * _csp_qTwist.y
                             + _csp_qTwist.z * _csp_qTwist.z + _csp_qTwist.w * _csp_qTwist.w);
        if (tLen > 1e-6) {
            _csp_qTwist.x /= tLen; _csp_qTwist.y /= tLen; _csp_qTwist.z /= tLen; _csp_qTwist.w /= tLen;
        } else {
            _csp_qTwist.set(0, 0, 0, 1);
        }

        // q_final = twist × q_naive；写回 _csp_qOut
        _csp_qOut.copy(_csp_qNaive).premultiply(_csp_qTwist);

        // 平移也要随之更新：保持"source port world 位置"还在 targetPortPos。
        // q_final 让 source part 绕端口轴旋转了 twist 角度，但旋转中心**应当**
        // 是端口位置（不是零件原点）。所以从 q_final 反推零件位置：
        //   targetPortPos = q_final × sourcePortPos + partPos
        //   → partPos = targetPortPos - q_final × sourcePortPos
        _csp_vIn.set(sourcePortPos[0], sourcePortPos[1], sourcePortPos[2])
            .applyQuaternion(_csp_qOut);
        _csp_vOut.set(targetPortPos[0], targetPortPos[1], targetPortPos[2]).sub(_csp_vIn);

        // slideOffset 在端口轴上额外平移（端口轴 = _csp_vPortZ 经 twist 旋转后的方向；
        // 但 twist 绕该轴 → 轴不变）。直接沿 _csp_vPortZ 加 slideOffset。
        if (slideOffset !== 0) {
            _csp_vOut.addScaledVector(_csp_vPortZ, slideOffset);
        }
    }

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

// quatTimesAxisAngle 专用
const _qaa_axis = new THREE.Vector3();
const _qaa_dq = new THREE.Quaternion();
const _qaa_q = new THREE.Quaternion();

/**
 * 世界轴预乘旋转：返回 `axisAngle(axis, angle) ⊗ q`。
 *
 * 用于"选中已放置零件本体后绕世界轴整体旋转"（rotateSelectedGroup）。预乘
 * （把增量旋转放左边）= 在 **世界坐标系** 的 axis 上转，而非零件局部轴 —— 这
 * 样不论零件当前朝向如何，按 [/] 永远是绕竖直 Y 轴水平自旋，符合"在桌面上转
 * 这个装配"的直觉。
 *
 * @param q     原四元数 [x,y,z,w]
 * @param axis  世界轴（内部归一化）
 * @param angle 弧度
 */
export function quatTimesAxisAngle(
    q: [number, number, number, number],
    axis: [number, number, number],
    angle: number,
): [number, number, number, number] {
    _qaa_axis.set(axis[0], axis[1], axis[2]).normalize();
    _qaa_dq.setFromAxisAngle(_qaa_axis, angle);
    _qaa_q.set(q[0], q[1], q[2], q[3]);
    _qaa_dq.multiply(_qaa_q); // dq ⊗ q（世界轴预乘）
    return [_qaa_dq.x, _qaa_dq.y, _qaa_dq.z, _qaa_dq.w];
}

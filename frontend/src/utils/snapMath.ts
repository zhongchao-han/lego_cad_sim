import * as THREE from 'three';

/**
 * 沿轴滑动时的物理限位计算 (Collision Clamping)
 * TS-6.3: 携带 shiftKey 能够无视物理限位直接穿模
 */
export function calculateClampedOffset(offset: number, shiftKey: boolean, limit: number = 20 * 0.4): number {
    if (shiftKey) return offset; // Shift 键屏蔽物理碰撞和限位
    return Math.max(-limit, Math.min(limit, offset));
}

/**
 * 核心对齐算法 (Point-to-Point Snap Engine)
 * 目标：将 Source 端口 重合于 Target 端口，且 Z 轴对扣，主轴（Y/X）对齐平滑。
 * 
 * @param sourcePortPos    来源端口（插销上那个）在当前零件局部坐标下的位置
 * @param sourcePortQuat   来源端口在当前零件局部坐标下的旋转
 * @param targetPortPos    目标端口（梁上那个）在组装场景下的全局位置
 * @param targetPortQuat   目标端口在组装场景下的全局旋转
 * @returns { position: Vector3, quaternion: Quaternion } 零件落位的全局位姿
 */
export function calculateSnapPose(
    sourcePortPos: [number, number, number],
    sourcePortQuat: [number, number, number, number],
    targetPortPos: [number, number, number],
    targetPortQuat: [number, number, number, number],
    slideOffset: number = 0
) {
    // 1. 构造 Target 端口的全局矩阵 (T_target)
    const m_target = new THREE.Matrix4().compose(
        new THREE.Vector3(...targetPortPos),
        new THREE.Quaternion(...targetPortQuat),
        new THREE.Vector3(1, 1, 1)
    );

    // 2. 构造 Source 端口在 零件局部 坐标系下的矩阵 (T_source_local)
    const m_source_local = new THREE.Matrix4().compose(
        new THREE.Vector3(...sourcePortPos),
        new THREE.Quaternion(...sourcePortQuat),
        new THREE.Vector3(1, 1, 1)
    );

    // 3. 核心物理变换：对扣对齐
    const m_flip = new THREE.Matrix4().makeRotationX(Math.PI); 
    
    // M_part = T_target * T_flip * (T_source_local)^-1
    let m_part = m_target.clone()
        .multiply(m_flip)
        .multiply(m_source_local.invert());

    // 4. 沿轴滑动 (Axial Sliding)
    // 偏移量是在连接轴（即对齐后的 Source 端口 Z 轴）上移动
    if (slideOffset !== 0) {
        const m_offset = new THREE.Matrix4().makeTranslation(0, 0, slideOffset);
        
        // 这里的逻辑是：零件整体相对于“完美吸附位”再偏移。
        // 由于 m_part 是将零件原点移到位的矩阵，我们可以在 m_target * m_flip 之后应用位移
        const m_final_snap = m_target.clone().multiply(m_flip).multiply(m_offset);
        m_part = m_final_snap.multiply(m_source_local.invert());
    }

    const finalPos = new THREE.Vector3();
    const finalQuat = new THREE.Quaternion();
    const finalScale = new THREE.Vector3();
    m_part.decompose(finalPos, finalQuat, finalScale);

    return {
        position: [finalPos.x, finalPos.y, finalPos.z] as [number, number, number],
        quaternion: [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w] as [number, number, number, number]
    };
}

/**
 * 单个零件的位姿描述（与 PartState 兼容子集）。
 */
export interface RigidPose {
    position:   [number, number, number];
    quaternion: [number, number, number, number];
}

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
    const m_old = new THREE.Matrix4().compose(
        new THREE.Vector3(...oldSource.position),
        new THREE.Quaternion(...oldSource.quaternion),
        new THREE.Vector3(1, 1, 1),
    );
    const m_new = new THREE.Matrix4().compose(
        new THREE.Vector3(...newSource.position),
        new THREE.Quaternion(...newSource.quaternion),
        new THREE.Vector3(1, 1, 1),
    );
    // delta = m_new × m_old⁻¹
    const m_delta = m_new.clone().multiply(m_old.clone().invert());

    const result: Record<string, RigidPose> = {};
    const tmpPos = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3();
    srcGroup.forEach(pid => {
        if (pid === sourceId) {
            result[pid] = newSource;
            return;
        }
        const p = parts[pid];
        if (!p) return;
        const m_part = new THREE.Matrix4().compose(
            new THREE.Vector3(...p.position),
            new THREE.Quaternion(...p.quaternion),
            new THREE.Vector3(1, 1, 1),
        );
        const m_part_new = m_delta.clone().multiply(m_part);
        m_part_new.decompose(tmpPos, tmpQuat, tmpScale);
        result[pid] = {
            position:   [tmpPos.x,  tmpPos.y,  tmpPos.z],
            quaternion: [tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w],
        };
    });
    return result;
}

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
    const m_part = new THREE.Matrix4().compose(
        new THREE.Vector3(...partPos),
        new THREE.Quaternion(...partQuat),
        new THREE.Vector3(1, 1, 1)
    );

    const m_port_local = new THREE.Matrix4().compose(
        new THREE.Vector3(...portLocalPos),
        new THREE.Quaternion(...portLocalQuat),
        new THREE.Vector3(1, 1, 1)
    );

    // 计算端口的当前全局矩阵
    const m_port_global = m_part.clone().multiply(m_port_local);

    // 在端口自身局部坐标系下绕 Z 轴旋转
    const m_rot_z = new THREE.Matrix4().makeRotationZ(angleRads);
    const m_port_new = m_port_global.multiply(m_rot_z);

    // 反推零件的新全局矩阵
    const m_part_new = m_port_new.multiply(m_port_local.invert());

    const finalPos = new THREE.Vector3();
    const finalQuat = new THREE.Quaternion();
    const finalScale = new THREE.Vector3();
    m_part_new.decompose(finalPos, finalQuat, finalScale);

    return {
        position: [finalPos.x, finalPos.y, finalPos.z] as [number, number, number],
        quaternion: [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w] as [number, number, number, number]
    };
}

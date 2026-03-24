import * as THREE from 'three';

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

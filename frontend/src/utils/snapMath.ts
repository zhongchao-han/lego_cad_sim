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
    targetPortQuat: [number, number, number, number]
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
    // 我们需要零件本身的矩阵 M_part，使得 M_part * T_source_local = T_target * T_flip
    // T_flip 是将端口 Z 轴旋转 180 度的翻转矩阵（对扣）
    const m_flip = new THREE.Matrix4().makeRotationX(Math.PI); 
    
    // M_part = T_target * T_flip * (T_source_local)^-1
    const m_part = m_target.clone()
        .multiply(m_flip)
        .multiply(m_source_local.invert());

    const finalPos = new THREE.Vector3();
    const finalQuat = new THREE.Quaternion();
    const finalScale = new THREE.Vector3();
    m_part.decompose(finalPos, finalQuat, finalScale);

    return {
        position: [finalPos.x, finalPos.y, finalPos.z] as [number, number, number],
        quaternion: [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w] as [number, number, number, number]
    };
}

import React, { Suspense, memo, useRef, useEffect, useState, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Environment, BakeShadows, GizmoHelper, GizmoViewport, ContactShadows } from '@react-three/drei';
import { Perf } from 'r3f-perf';
import { useStore, getConnectedGroup } from './store';
import { InteractivePart } from './components/InteractivePart';
import { CameraController } from './CameraController';
import { MarqueeSelectionOverlay } from './components/MarqueeSelectionOverlay';

import { FreePlacingProjectionMode, InteractionPhase, ZoneType } from './types';
import { calculateSnapPose, applyGroupDelta } from './utils/snapMath';

const LegoPart = memo(({ id }) => {
    const state = useStore((s) => s.parts[id]);
    const mode = useStore((s) => s.mode);
    const showPortGizmos = useStore((s) => s.showPortGizmos);
    const handlePortClickStore = useStore((s) => s.handlePortClick);
    const setHoveredPort = useStore((s) => s.setHoveredPort);
    const setFocus = useStore((s) => s.setFocus);
    const stagePart = useStore((s) => s.stagePart);

    if (!state) return null;

    const onDoubleClick = () => {
        if (mode === 'ASSEMBLY' && state.zone === ZoneType.ACTIVE_ARENA) {
            stagePart(id);
        } else {
            setFocus({ partId: id, mode: 'part' });
        }
    };

    return (
        <group position={state.position} quaternion={state.quaternion}>
             <InteractivePart
                partId={id}
                ldrawId={state.ldrawId}
                colorCode={state.colorCode}
                showPorts={mode === 'ASSEMBLY' && showPortGizmos}
                onPortClick={handlePortClickStore}
                onPortHover={setHoveredPort}
                onDoubleClick={onDoubleClick}
             />
        </group>
    );
});

/**
 * 实时对齐幽灵 (PlacementGhost)
 */
import { getDefaultColorCode } from './utils/partColorDefaults';

const PlacementGhost = () => {
    const selectedPort = useStore(s => s.selectedPort);
    const hoveredPort = useStore(s => s.hoveredPort);
    const phase = useStore(s => s.interactionPhase);
    const continuousPlacementSource = useStore(s => s.continuousPlacementSource);
    const activeColorCode = useStore(s => s.activeColorCode);
    const parts = useStore(s => s.parts);
    const connections = useStore(s => s.connections);
    const addLog = useStore(s => s.addLog);

    const isActivePhase = phase === InteractionPhase.SOURCE_LOCKED || (phase === InteractionPhase.AXIAL_SLIDING && continuousPlacementSource);

    // 当前活跃 source（用作 sticky 重置的 key —— source 一变，sticky 立刻清空）
    const source = (phase === InteractionPhase.AXIAL_SLIDING && continuousPlacementSource)
      ? continuousPlacementSource
      : selectedPort;
    const sourceId = source?.partId ?? null;

    // ── Sticky hover 锚点 ──────────────────────────────────────────────────
    // hoveredPort 在用户鼠标真正离开所有端口时会被清空。但用户在多个候选孔之间慢慢
    // 移动鼠标看效果时，本能上会"鼠标停在两孔之间想一下再移过去"，那段空窗会让幽灵
    // 反复挂载-卸载，肉眼级别闪烁。
    //
    // 这里用一个"粘性"锚点：
    //   - 一旦有非空 hoveredPort 就更新；
    //   - hoveredPort 变 null 不更新（保留上一次的值，幽灵不撤）；
    //   - source 变化（点新 source / abort / commit）时立即清空，避免脏锚点。
    // 实质是"幽灵贴在最近一次 hover 的端口上，直到换到另一个端口或源换了为止"。
    //
    // 实现：用 render-time 派生 state（React 文档的 "Storing information from previous renders"），
    // 不放 useEffect，避免触发 react-hooks/set-state-in-effect。
    // 用两个 tracked-* state 做 "上次见到的值" 比较，严格对应原 useEffect dep 数组语义。
    const [stickyHover, setStickyHover] = useState(null);
    const [trackedSourceId, setTrackedSourceId] = useState(sourceId);
    const [trackedHovered, setTrackedHovered] = useState(hoveredPort);

    // source 一换：立刻清空 sticky（对应原 useEffect dep [sourceId]）
    if (sourceId !== trackedSourceId) {
        setTrackedSourceId(sourceId);
        setStickyHover(null);
    }
    // hoveredPort 切到非空新端口：累积到 sticky（对应原 useEffect dep [hoveredPort]，
    // 且原代码里 hoveredPort 变 null 不更新，这里保留同样行为）
    if (hoveredPort !== trackedHovered) {
        setTrackedHovered(hoveredPort);
        if (hoveredPort) setStickyHover(hoveredPort);
    }

    // 诊断：每次满足渲染条件触发一次（注意是 useEffect 防止 render 内 set state 死循环）
    useEffect(() => {
        if (isActivePhase && stickyHover) {
            addLog(`[Ghost] mount/update @ source=${sourceId ?? '?'} hover=${stickyHover.partId}`, 'INFO');
        }
    }, [isActivePhase, stickyHover, sourceId, addLog]);

    if (!isActivePhase || !stickyHover) return null;
    if (!source) return null;

    // 实际渲染参考的是 sticky 锚点而不是 live hoveredPort
    const anchorPort = stickyHover;

    // 采用工业级稳健解算器，相信后端已完成旋向纠偏，但前端需具备处理任意正交阵的能力
    const getQuatFromMat = (m) => {
        const mm = m;
        const nm = [];
        for (let col = 0; col < 3; col++) {
            const v = [mm[0][col], mm[1][col], mm[2][col]];
            const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
            nm.push([v[0]/len, v[1]/len, v[2]/len]);
        }

        // 列向量 nm 映射到矩阵元素 (Row-Major index mapping)
        const m11 = nm[0][0], m12 = nm[1][0], m13 = nm[2][0];
        const m21 = nm[0][1], m22 = nm[1][1], m23 = nm[2][1];
        const m31 = nm[0][2], m32 = nm[1][2], m33 = nm[2][2];

        const tr = m11 + m22 + m33;
        let q = [0, 0, 0, 1];

        if (tr > 0) {
            const s = 0.5 / Math.sqrt(tr + 1.0);
            q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
        } else if (m11 > m22 && m11 > m33) {
            const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
            q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
        } else if (m22 > m33) {
            const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
            q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
        } else {
            const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
            q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
        }

        const qLen = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]) || 1;
        return [q[0]/qLen, q[1]/qLen, q[2]/qLen, q[3]/qLen];
    };

    const previewPose = calculateSnapPose(
        source.position,
        getQuatFromMat(source.rotation),
        anchorPort.globalPos,
        anchorPort.globalQuat
    );

    // 计算 source 所在的连通组（剔除潜在 target，避免把 target 也拖走）。
    // 组内每个零件按"source 的位姿位移"作为刚体 delta 重新摆放，
    // 这样幽灵能预览整套"灰板 + 已经插上的销"飞过去的样子，而不是只一根销。
    const srcGroup = getConnectedGroup(connections, source.partId, anchorPort.partId);
    const oldSourcePose = parts[source.partId]
      ? { position: parts[source.partId].position, quaternion: parts[source.partId].quaternion }
      : { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    const newSourcePose = { position: previewPose.position, quaternion: previewPose.quaternion };
    const groupNewPoses = applyGroupDelta(
        srcGroup, parts, source.partId, oldSourcePose, newSourcePose
    );

    const ghostColor = getDefaultColorCode(source.ldrawId || source.partId, activeColorCode);

    return (
        <group>
            {/* source 自身的幽灵：始终渲染（即使 source 还没在 parts 字典中——preview 路径） */}
            <group position={previewPose.position} quaternion={previewPose.quaternion}>
                <InteractivePart
                    partId="ghost"
                    ldrawId={source.ldrawId}
                    colorCode={ghostColor}
                    opacity={0.4}
                    transparent={true}
                    showPorts={false}
                    disableEvents={true}
                />
            </group>
            {/* 同组其余零件的幽灵：当 source 在场景里且有连通邻居时，整套预览跟过去 */}
            {srcGroup.filter(pid => pid !== source.partId).map(pid => {
                const orig = parts[pid];
                const newPose = groupNewPoses[pid];
                if (!orig || !newPose) return null;
                return (
                    <group key={`ghost_grp_${pid}`} position={newPose.position} quaternion={newPose.quaternion}>
                        <InteractivePart
                            partId={`ghost_${pid}`}
                            ldrawId={orig.ldrawId}
                            colorCode={orig.colorCode}
                            opacity={0.4}
                            transparent={true}
                            showPorts={false}
                            disableEvents={true}
                        />
                    </group>
                );
            })}
        </group>
    );
};
const FreePlacerGhost = () => {
    const phase = useStore(s => s.interactionPhase);
    const payload = useStore(s => s.freePlacingPayload);
    const projectionMode = useStore(s => s.freePlacingProjectionMode);
    const initialPointer = useStore(s => s.freePlacingPointer);
    const previewCamQuat = useStore(s => s.freePlacingPreviewCamQuat);
    const commitFreePlacing = useStore(s => s.commitFreePlacing);
    const groupRef = useRef(null);
    // 内层 group 的 ref：用于在 useFrame 里实时把 quaternion 设为
    // sceneCam.quat * previewCam.quat^-1，做到"模态看到的那一面就是落地后的顶面"。
    const innerRefs = useRef([]);
    const { raycaster, mouse, camera, scene, gl } = useThree();

    // 把 [x,y,z,w] 数组形式的预览相机 quaternion 提前转成 THREE.Quaternion，
    // useFrame 里只做 multiply / copy，不再每帧 new 对象。
    const previewCamQuatThree = useMemo(() => {
        if (!previewCamQuat) return null;
        return new THREE.Quaternion(previewCamQuat[0], previewCamQuat[1], previewCamQuat[2], previewCamQuat[3]).invert();
    }, [previewCamQuat]);

    const isPlacing = phase === InteractionPhase.FREE_PLACING && payload && payload.length > 0;
    const isGroundPlane = projectionMode === FreePlacingProjectionMode.GROUND_PLANE;

    // GROUND_PLANE 路径专用：用 window 级别的 pointermove 自维护 NDC 坐标，
    // 绕开 R3F mouse 在 modal 关闭瞬间可能仍然停留在旧值的问题。
    // SCENE_RAYCAST 路径不使用此 ref，沿用 R3F 的 mouse。
    const groundPointerRef = useRef(new THREE.Vector2(0, 0));
    // 防止"触发 Drop to Ground 的那次 mousedown"被全局监听器解读为放置确认。
    const canConfirmGroundRef = useRef(false);

    // 实时把内层 group 的 quaternion 设为 sceneCam.quat * previewCam.quat^-1：
    // 这样从场景相机看下去，零件呈现的面与用户在模态预览里看到的那一面一致。
    // 用户在场景里转动相机，ghost 也会跟着重旋（朝向永远迎合当前视角）。
    const _ghostQuatScratch = useMemo(() => new THREE.Quaternion(), []);
    const updateGhostOrientation = () => {
        if (!previewCamQuatThree) return;
        _ghostQuatScratch.copy(camera.quaternion).multiply(previewCamQuatThree);
        innerRefs.current.forEach(el => { if (el) el.quaternion.copy(_ghostQuatScratch); });
    };

    useFrame(() => {
        if (!isPlacing || !groupRef.current) return;

        // 朝向实时跟随场景相机（如未传 previewCamQuat 则保持 identity，向后兼容）
        updateGhostOrientation();

        if (isGroundPlane) {
            // 仅与 y=0 平面求交，忽略环境软箱、阴影面与现有零件
            raycaster.setFromCamera(groundPointerRef.current, camera);
            const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
            const intersectPoint = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(groundPlane, intersectPoint)) {
                groupRef.current.position.copy(intersectPoint);
            } else {
                raycaster.ray.at(0.2, groupRef.current.position);
            }
            return;
        }

        raycaster.setFromCamera(mouse, camera);

        // 射线撞击检测，忽略自身 (Ghost) 以免被遮挡
        const hits = raycaster.intersectObjects(scene.children, true).filter(h => {
            let p = h.object;
            while(p) {
                if (p === groupRef.current) return false;
                p = p.parent;
            }
            return true;
        });

        if (hits.length > 0) {
            groupRef.current.position.copy(hits[0].point);
        } else {
            // 兜底：投射到 y=0 (地面)
            const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
            const intersectPoint = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(groundPlane, intersectPoint)) {
                groupRef.current.position.copy(intersectPoint);
            } else {
                // 如果光线平行于地面或朝上，给一个合理的近处距离（0.2米）而不是 10 米
                raycaster.ray.at(0.2, groupRef.current.position);
            }
        }
    });

    // GROUND_PLANE 专用：在 window 级别监听 pointermove，自维护 NDC 坐标。
    useEffect(() => {
        if (!isPlacing || !isGroundPlane) return;

        const updateFromClient = (clientX, clientY) => {
            const rect = gl.domElement.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            groundPointerRef.current.set(
                ((clientX - rect.left) / rect.width) * 2 - 1,
                -(((clientY - rect.top) / rect.height) * 2 - 1)
            );
        };

        // 用按钮点击坐标做首帧初值，避免幽灵第一帧落在原点
        if (initialPointer) {
            updateFromClient(initialPointer.clientX, initialPointer.clientY);
        }

        const onMove = (e) => updateFromClient(e.clientX, e.clientY);
        window.addEventListener('pointermove', onMove);
        return () => {
            window.removeEventListener('pointermove', onMove);
        };
    }, [isPlacing, isGroundPlane, initialPointer, gl]);

    // GROUND_PLANE 专用：~120ms 防抖，避免触发 Drop to Ground 的那次 mousedown
    // 在 modal 关闭后被全局监听器误判为"确认放置"。
    useEffect(() => {
        if (!isPlacing || !isGroundPlane) {
            canConfirmGroundRef.current = false;
            return;
        }
        canConfirmGroundRef.current = false;
        const t = window.setTimeout(() => { canConfirmGroundRef.current = true; }, 120);
        return () => window.clearTimeout(t);
    }, [isPlacing, isGroundPlane]);

    useEffect(() => {
        if (!isPlacing) return;

        // 利用全局拦截处理左键确认放置和右键/Esc取消放置
        const handleClick = (e) => {
            // 忽略非画布点击
            if (e.target.tagName !== 'CANVAS') return;
            if (!groupRef.current) return;
            if (isGroundPlane && !canConfirmGroundRef.current) return;

            if (e.button === 0) { // 左键放置
                const finalStates = {};
                const pos = groupRef.current.position;
                // 与 ghost 同样逻辑：把模态视角对齐到场景视角，保证落地后看到的还是
                // 模态里那一面。previewCamQuatThree 缺席时退回 identity，行为不变。
                let finalQuat = null;
                if (previewCamQuatThree) {
                    const q = new THREE.Quaternion().copy(camera.quaternion).multiply(previewCamQuatThree);
                    finalQuat = [q.x, q.y, q.z, q.w];
                }
                payload.forEach(item => {
                    finalStates[item.id] = {
                        ...item.state,
                        position: [item.state.position[0] + pos.x, item.state.position[1] + pos.y, item.state.position[2] + pos.z],
                        quaternion: finalQuat || item.state.quaternion
                    };
                });
                commitFreePlacing(finalStates);
            } else if (e.button === 2) { // 右键取消
                commitFreePlacing(undefined);
            }
        };

        const handleKey = (e) => {
            if (e.key === 'Escape') commitFreePlacing(undefined);
        };

        // 捕获阶段拦截，防止点击到下面的零件
        window.addEventListener('mousedown', handleClick, { capture: true });
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('mousedown', handleClick, { capture: true });
            window.removeEventListener('keydown', handleKey);
        };
    }, [isPlacing, isGroundPlane, payload, commitFreePlacing, previewCamQuatThree, camera]);

    if (!isPlacing) return null;

    return (
        <group ref={groupRef}>
            {payload.map((item, idx) => (
                <group
                    key={item.id}
                    ref={el => { innerRefs.current[idx] = el; }}
                    position={item.state.position}
                    quaternion={item.state.quaternion}
                >
                    {/* quaternion 写在初始化 prop 上仅作首帧兜底；previewCamQuat 在场时
                        useFrame 每帧 copy 真正的目标朝向，覆盖 R3F 重新 commit 的值。 */}
                    <InteractivePart
                        partId={`ghost_${item.id}`}
                        ldrawId={item.state.ldrawId}
                        colorCode={item.state.colorCode}
                        opacity={0.6}
                        transparent={true}
                        showPorts={false}
                        isStatic={true}
                    />
                </group>
            ))}
        </group>
    );
};

import { EffectComposer } from '@react-three/postprocessing';

export default function Scene() {
    const parts = useStore((s) => s.parts);
    const debugMode = useStore((s) => s.debugMode);
    const cameraTarget = useStore((s) => s.cameraTarget);
    const hiddenParts = useStore((s) => s.hiddenParts);

    return (
        <>
            {debugMode && <Perf position="top-left" style={{ top: '24px', left: '300px' }} minimal={true} />}
            
            {/* Outline Effect removed due to react-three/postprocessing Selection context infinite loop bug */}

            {/* 宏观治理：使用程序化虚拟现实工作室，彻底脱离在线 CDN 依赖 */}
            <Environment frames={1} resolution={256}>
              <group>
                {/* 模拟摄影棚软灯箱 (Soft Box) */}
                <mesh position={[0, 5, 0]} rotation={[Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[10, 10]} />
                  <meshBasicMaterial color="white" />
                </mesh>
                <mesh position={[5, 0, 2]} rotation={[0, -Math.PI / 2, 0]}>
                  <planeGeometry args={[10, 10]} />
                  <meshBasicMaterial color="white" />
                </mesh>
                <mesh position={[-5, 0, -2]} rotation={[0, Math.PI / 2, 0]}>
                  <planeGeometry args={[10, 10]} />
                  <meshBasicMaterial color="white" />
                </mesh>
              </group>
            </Environment>
            
            <ambientLight intensity={0.6} />
            <directionalLight
                position={[0.8, 1.5, 1.2]}
                intensity={2.0}
                castShadow
            />
            <directionalLight position={[-1.2, 0.8, -1.0]} intensity={0.8} />

            <CameraController target={cameraTarget} />

            {Object.keys(parts).filter(id => parts[id].zone === ZoneType.ACTIVE_ARENA && !hiddenParts.has(id)).map(id => (
                <LegoPart key={id} id={id} />
            ))}
            <PlacementGhost />
            <FreePlacerGhost />
            <MarqueeSelectionOverlay />

            <ContactShadows opacity={0.4} scale={10} blur={2.4} far={0.8} />
            <gridHelper args={[0.5, 30, '#bbb', '#e8e8e8']} position={[0, -0.01, 0]} />

            {debugMode && (
                <axesHelper args={[0.2]} />
            )}

            <BakeShadows />
        </>
    );
}

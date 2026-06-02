import React, { Suspense, memo, useRef, useEffect, useState, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Environment, BakeShadows, GizmoHelper, GizmoViewport, ContactShadows } from '@react-three/drei';
import { Perf } from 'r3f-perf';
import { useStore, getConnectedGroup, ensurePortGeom } from './store';
import { computeSnapDelta } from './utils/portSnap';
import { InteractivePart } from './components/InteractivePart';
import { CameraController } from './CameraController';
import { MarqueeSelectionOverlay } from './components/MarqueeSelectionOverlay';
import { CenterOfMassGizmo } from './components/CenterOfMassGizmo';
import { ReactionForceVisualizer } from './components/ReactionForceVisualizer';
import { analyzeStability } from './utils/staticsMath';

import { FreePlacingProjectionMode, InteractionPhase, ZoneType } from './types';
import { calculateSnapPose, applyGroupDelta } from './utils/snapMath';

const LegoPart = memo(({ id }) => {
    const state = useStore((s) => s.parts[id]);
    const mode = useStore((s) => s.mode);
    const showPortGizmos = useStore((s) => s.showPortGizmos);
    const handlePortClickStore = useStore((s) => s.handlePortClick);
    const setHoveredPort = useStore((s) => s.setHoveredPort);
    const setFocus = useStore((s) => s.setFocus);

    if (!state) return null;

    const onDoubleClick = () => {
        setFocus({ partId: id, mode: 'part' });
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
    const commitFreePlacing = useStore(s => s.commitFreePlacing);
    // Ghost-on-drag snap：拖入零件时实时算"吸附后位置"，ghost 直接显示吸附后状态
    // → 用户落地前知道会 snap 到哪。复用 PR #180 的 computeSnapDelta（之前接入点已移除、
    // 这里是更合适的接入点：用户主动拖入零件时才吸，不会干扰键盘平移）
    const sceneParts = useStore(s => s.parts);
    const groupRef = useRef(null);
    const { raycaster, camera, scene, gl } = useThree();

    // 朝向说明（UX 反馈修复）：Drop to Ground / 自由放置一律落在零件的**原始
    // 朝向**（payload state.quaternion，新建零件 = identity 平躺）。
    // 旧实现把"模态相机朝向"经 sceneCam·previewCam⁻¹ 带进落地姿态，想做到
    // "落地看到的面 = 模态里看到的面"，但只要用户在模态里 orbit 转过视角，
    // 这个相机相对旋转几乎必然不是轴对齐 → 零件落地歪斜、难操作。改为永远
    // 轴对齐平躺；用户落地后用 [ / ] 做 90° 旋转即可，行为可预期。

    const isPlacing = phase === InteractionPhase.FREE_PLACING && payload && payload.length > 0;
    const isGroundPlane = projectionMode === FreePlacingProjectionMode.GROUND_PLANE;

    // 用 window 级别的 pointermove 自维护 NDC 坐标，绕开 R3F mouse 可能停在旧值的问题。
    // 历史 bug：此 ref 曾仅 GROUND_PLANE 使用，SCENE_RAYCAST（粘贴走的路径）沿用 R3F
    // `mouse` —— 但 Ctrl+V 由键盘触发、没有指针事件喂给 R3F，`mouse` 停在旧值 → 粘贴
    // 的幽灵不跟手。现两条路径统一用此 ref，跟手稳定。
    const pointerNdcRef = useRef(new THREE.Vector2(0, 0));
    // 防止"触发 Drop to Ground 的那次 mousedown"被全局监听器解读为放置确认。
    const canConfirmGroundRef = useRef(false);

    // L54 对象池：useFrame 60Hz 跑，过去每帧 new Plane + Vector3 触发 GC 尖刺。
    // y=0 地面是常量、intersectPoint 只读出来 copy 走，全部 useMemo 提一次即可。
    const _groundPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
    const _intersectScratch = useMemo(() => new THREE.Vector3(), []);

    // Ghost-on-drag snap 缓存：useFrame 同步要 port 几何，提前异步拉好放 ref。
    // 涉及的 ldrawId = payload + 场内所有 ACTIVE_ARENA 件。
    const portsCacheRef = useRef({}); // { [ldrawId]: SnapPortInput[] }
    useEffect(() => {
        if (!isPlacing) return;
        const ldraws = new Set();
        payload.forEach(it => { if (it.state?.ldrawId) ldraws.add(it.state.ldrawId); });
        Object.values(sceneParts).forEach(p => {
            if (p.zone === ZoneType.ACTIVE_ARENA && p.ldrawId) ldraws.add(p.ldrawId);
        });
        if (ldraws.size === 0) return;
        let cancelled = false;
        ensurePortGeom([...ldraws]).then(map => {
            if (!cancelled) portsCacheRef.current = map;
        }).catch(() => { /* 拉端口失败不影响 ghost 跟手；snap 静默退回 */ });
        return () => { cancelled = true; };
    }, [isPlacing, payload, sceneParts]);

    // snap 节流：useFrame 60Hz、computeSnapDelta 是 O(N×M²) 容易卡。每 4 帧算一次
    // 视觉就够（15Hz 吸附跟手没问题），把高频留给 raycast 跟手。
    const snapTickRef = useRef(0);
    const lastSnapDeltaRef = useRef([0, 0, 0]);

    useFrame(() => {
        if (!isPlacing || !groupRef.current) return;

        // ghost 朝向 = 零件原始姿态（quaternion 由渲染 prop 给，identity 平躺），
        // 不再随相机重旋 —— 落地永远轴对齐，避免歪斜（见上方朝向说明）。

        if (isGroundPlane) {
            // 仅与 y=0 平面求交，忽略环境软箱、阴影面与现有零件
            raycaster.setFromCamera(pointerNdcRef.current, camera);
            if (raycaster.ray.intersectPlane(_groundPlane, _intersectScratch)) {
                groupRef.current.position.copy(_intersectScratch);
            } else {
                raycaster.ray.at(0.2, groupRef.current.position);
            }
            return;
        }

        // SCENE_RAYCAST：用自维护的 NDC（而非 R3F mouse），保证键盘触发的粘贴也跟手。
        raycaster.setFromCamera(pointerNdcRef.current, camera);

        // 射线撞击检测，忽略自身 (Ghost) 以免被遮挡
        const hits = raycaster.intersectObjects(scene.children, true).filter(h => {
            let p = h.object;
            while(p) {
                if (p === groupRef.current) return false;
                p = p.parent;
            }
            return true;
        });

        // 1. 先算 raw（raycast 命中点 / 地面 / 兜底）。**不直接写 groupRef** —— 后面要叠
        //    snap delta，避免"上一帧的 delta 被当成下一帧的 raw 输入"导致漂移。
        let rawX, rawY, rawZ;
        if (hits.length > 0) {
            rawX = hits[0].point.x; rawY = hits[0].point.y; rawZ = hits[0].point.z;
        } else if (raycaster.ray.intersectPlane(_groundPlane, _intersectScratch)) {
            rawX = _intersectScratch.x; rawY = _intersectScratch.y; rawZ = _intersectScratch.z;
        } else {
            raycaster.ray.at(0.2, _intersectScratch);
            rawX = _intersectScratch.x; rawY = _intersectScratch.y; rawZ = _intersectScratch.z;
        }

        // 2. Ghost-on-drag snap：每 4 帧从 **raw 位置** 算一次 delta（O(N×M) 不轻）。
        //    复用上次 delta 维持视觉稳定，cursor 跟手用 raw 即可。
        snapTickRef.current = (snapTickRef.current + 1) % 4;
        if (snapTickRef.current === 0) {
            const portGeom = portsCacheRef.current;
            if (portGeom && Object.keys(portGeom).length > 0) {
                const movingParts = payload
                    .filter(it => it.state?.ldrawId)
                    .map(it => ({
                        id: it.id,
                        ldrawId: it.state.ldrawId,
                        position: [
                            it.state.position[0] + rawX,
                            it.state.position[1] + rawY,
                            it.state.position[2] + rawZ,
                        ],
                        quaternion: it.state.quaternion,
                    }));
                const staticParts = Object.entries(sceneParts)
                    .filter(([, p]) => p.zone === ZoneType.ACTIVE_ARENA)
                    .map(([pid, p]) => ({
                        id: pid, ldrawId: p.ldrawId,
                        position: p.position, quaternion: p.quaternion,
                    }));
                const delta = computeSnapDelta(movingParts, staticParts, portGeom);
                lastSnapDeltaRef.current = delta ?? [0, 0, 0];
            }
        }

        // 3. groupRef = raw + lastSnapDelta（ghost 显示吸附后位置）
        const d = lastSnapDeltaRef.current;
        groupRef.current.position.set(rawX + d[0], rawY + d[1], rawZ + d[2]);
    });

    // 在 window 级别监听 pointermove，自维护 NDC 坐标（两条投影路径共用）。
    useEffect(() => {
        if (!isPlacing) return;

        const updateFromClient = (clientX, clientY) => {
            const rect = gl.domElement.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            pointerNdcRef.current.set(
                ((clientX - rect.left) / rect.width) * 2 - 1,
                -(((clientY - rect.top) / rect.height) * 2 - 1)
            );
        };

        // 用初始指针坐标做首帧初值（Drop to Ground 的按钮点击坐标），避免幽灵第一帧落原点。
        // 粘贴无 initialPointer → 起于屏幕中心，首次移动鼠标即跟手。
        if (initialPointer) {
            updateFromClient(initialPointer.clientX, initialPointer.clientY);
        }

        const onMove = (e) => updateFromClient(e.clientX, e.clientY);
        window.addEventListener('pointermove', onMove);
        return () => {
            window.removeEventListener('pointermove', onMove);
        };
    }, [isPlacing, initialPointer, gl]);

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
                // 朝向 = 零件原始姿态（item.state.quaternion，新建 = identity 平躺）。
                // 不再用相机相对旋转，落地永远轴对齐（见上方朝向说明）。
                payload.forEach(item => {
                    finalStates[item.id] = {
                        ...item.state,
                        position: [item.state.position[0] + pos.x, item.state.position[1] + pos.y, item.state.position[2] + pos.z],
                        quaternion: item.state.quaternion
                    };
                });
                commitFreePlacing(finalStates);
            } else if (e.button === 2) { // 右键取消
                commitFreePlacing(undefined);
            }
        };

        // 修自 issue #61：Esc 在 FREE_PLACING 阶段的 abort 行为统一交给
        // useKeyboardDispatcher 处理（按 phase 分发到 commitFreePlacing(undefined)），
        // Scene.jsx 不再自己监听 keydown，避免两 handler 并行产生中间态
        // (phase=IDLE 但 freePlacingPayload 非空)。
        // 捕获阶段拦截 mousedown，防止点击到下面的零件。
        window.addEventListener('mousedown', handleClick, { capture: true });
        return () => {
            window.removeEventListener('mousedown', handleClick, { capture: true });
        };
    }, [isPlacing, isGroundPlane, payload, commitFreePlacing]);

    if (!isPlacing) return null;

    return (
        <group ref={groupRef}>
            {payload.map((item) => (
                <group
                    key={item.id}
                    position={item.state.position}
                    quaternion={item.state.quaternion}
                >
                    {/* 朝向固定为零件原始姿态（identity 平躺）；ghost 不再随相机重旋。 */}
                    <InteractivePart
                        partId={`ghost_${item.id}`}
                        ldrawId={item.state.ldrawId}
                        colorCode={item.state.colorCode}
                        opacity={isGroundPlane ? 1 : 0.6}
                        transparent={!isGroundPlane}
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
    const partCatalog = useStore((s) => s.partCatalog);
    const mode = useStore((s) => s.mode);
    const connections = useStore((s) => s.connections);
    const showReactionForces = useStore((s) => s.showReactionForces);
    const refreshReactionForces = useStore((s) => s.refreshReactionForces);

    // L51b PR-B：拓扑或 toggle 状态变化时重算反力。connections 是 ConnectionGraph
    // 引用稳定（snapParts 复制 + 增量更新触发引用变更），useEffect 比较自然 work。
    // 仅 toggle on 时拉，避免无谓后端调用。
    useEffect(() => {
        if (!showReactionForces) return;
        refreshReactionForces();
    }, [connections, showReactionForces, refreshReactionForces]);

    // L51：整体质心 + 静态稳定性。L51b PR-A：把 quaternion / comLocal / bbox*
    // 一并喂给 staticsMath，启用 part-local COM 修正 + bbox 8-corner footprint。
    const stability = useMemo(() => {
        if (mode !== 'ASSEMBLY') return null;
        const items = Object.values(parts)
            .filter(p => p.zone === ZoneType.ACTIVE_ARENA)
            .map(p => {
                const meta = partCatalog[p.ldrawId];
                return {
                    position:   p.position,
                    quaternion: p.quaternion,
                    mass:       meta?.massKg ?? 0.001,
                    comLocal:   meta?.comLocal ?? null,
                    bboxSize:   meta?.bboxSize ?? null,
                    bboxCenter: meta?.bboxCenter ?? null,
                };
            });
        if (items.length === 0) return null;
        return analyzeStability(items);
    }, [parts, partCatalog, mode]);

    return (
        <>
            {debugMode && <Perf position="top-left" style={{ top: '24px', left: '300px' }} minimal={true} />}
            
            {/* Outline Effect removed due to react-three/postprocessing Selection context infinite loop bug */}

            {/* 程序化虚拟摄影棚（无在线 CDN）。与缩略图生成器同配方：中性灰软箱 +
                柔和主/补光，避免白色环境光把零件洗平、保留塑料质感与明暗层次。 */}
            <Environment frames={1} resolution={256}>
              <group>
                {/* 模拟摄影棚软灯箱 (Soft Box) —— 中性灰，提升对比与立体感 */}
                <mesh position={[0, 5, 0]} rotation={[Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[10, 10]} />
                  <meshBasicMaterial color="#8a8a8a" />
                </mesh>
                <mesh position={[5, 0, 2]} rotation={[0, -Math.PI / 2, 0]}>
                  <planeGeometry args={[10, 10]} />
                  <meshBasicMaterial color="#8a8a8a" />
                </mesh>
                <mesh position={[-5, 0, -2]} rotation={[0, Math.PI / 2, 0]}>
                  <planeGeometry args={[10, 10]} />
                  <meshBasicMaterial color="#8a8a8a" />
                </mesh>
              </group>
            </Environment>

            <ambientLight intensity={0.55} />
            <directionalLight
                position={[0.8, 1.5, 1.2]}
                intensity={1.5}
                castShadow
            />
            <directionalLight position={[-1.2, 0.8, -1.0]} intensity={0.45} />

            <CameraController target={cameraTarget} />

            {Object.keys(parts).filter(id => parts[id].zone === ZoneType.ACTIVE_ARENA && !hiddenParts.has(id)).map(id => (
                <LegoPart key={id} id={id} />
            ))}
            <PlacementGhost />
            <FreePlacerGhost />
            <MarqueeSelectionOverlay />

            {/* L51：整体质心标记 —— 不稳定时变红警示 */}
            {stability?.com && (
                <CenterOfMassGizmo position={stability.com} isStable={stability.isStable} />
            )}

            {/* L51b PR-B：反力可视化（每条 edge 一支彩色箭头），默认隐藏 */}
            <ReactionForceVisualizer />

            <ContactShadows opacity={0.4} scale={10} blur={2.4} far={0.8} />
            <gridHelper args={[0.5, 30, '#bbb', '#e8e8e8']} position={[0, -0.01, 0]} />

            {debugMode && (
                <axesHelper args={[0.2]} />
            )}

            <BakeShadows />
        </>
    );
}

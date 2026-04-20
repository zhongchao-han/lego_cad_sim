import React, { Suspense, memo, useRef, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Environment, BakeShadows, GizmoHelper, GizmoViewport, ContactShadows } from '@react-three/drei';
import { Perf } from 'r3f-perf';
import { useStore } from './store';
import { InteractivePart } from './components/InteractivePart';
import { CameraController } from './CameraController';
import { MarqueeSelectionOverlay } from './components/MarqueeSelectionOverlay';

import { InteractionPhase, ZoneType } from './types';
import { calculateSnapPose } from './utils/snapMath';

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
    const activeColorCode = useStore(s => s.activeColorCode);

    if (phase !== InteractionPhase.SOURCE_LOCKED || !selectedPort || !hoveredPort) return null;

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
        selectedPort.position,
        getQuatFromMat(selectedPort.rotation),
        hoveredPort.globalPos,
        hoveredPort.globalQuat
    );

    const ghostColor = getDefaultColorCode(selectedPort.ldrawId || selectedPort.partId, activeColorCode);

    return (
        <group position={previewPose.position} quaternion={previewPose.quaternion}>
            <InteractivePart
                partId="ghost"
                ldrawId={selectedPort.ldrawId}
                colorCode={ghostColor}
                opacity={0.4}
                transparent={true}
                showPorts={false}
                disableEvents={true}
            />
        </group>
    );
};
const FreePlacerGhost = () => {
    const phase = useStore(s => s.interactionPhase);
    const payload = useStore(s => s.freePlacingPayload);
    const commitFreePlacing = useStore(s => s.commitFreePlacing);
    const groupRef = useRef(null);
    const { raycaster, mouse, camera, scene } = useThree();

    const isPlacing = phase === InteractionPhase.FREE_PLACING && payload && payload.length > 0;

    useFrame(() => {
        if (!isPlacing || !groupRef.current) return;
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
            // 兜底悬浮于空中
            raycaster.ray.at(10, groupRef.current.position);
        }
    });

    useEffect(() => {
        if (!isPlacing) return;
        
        // 利用全局拦截处理左键确认放置和右键/Esc取消放置
        const handleClick = (e) => {
            // 忽略非画布点击
            if (e.target.tagName !== 'CANVAS') return;
            if (!groupRef.current) return;
            
            if (e.button === 0) { // 左键放置
                const finalStates = {};
                const pos = groupRef.current.position;
                payload.forEach(item => {
                    finalStates[item.id] = {
                        ...item.state,
                        position: [item.state.position[0] + pos.x, item.state.position[1] + pos.y, item.state.position[2] + pos.z]
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
    }, [isPlacing, payload, commitFreePlacing]);

    if (!isPlacing) return null;

    return (
        <group ref={groupRef}>
            {payload.map(item => (
                <group key={item.id} position={item.state.position} quaternion={item.state.quaternion}>
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

import { EffectComposer, Outline } from '@react-three/postprocessing';

export default function Scene() {
    const parts = useStore((s) => s.parts);
    const debugMode = useStore((s) => s.debugMode);
    const cameraTarget = useStore((s) => s.cameraTarget);
    const hiddenParts = useStore((s) => s.hiddenParts);

    return (
        <>
            {debugMode && <Perf position="top-left" style={{ top: '24px', left: '300px' }} minimal={true} />}
            
            <EffectComposer autoClear={false} multisampling={0}>
                {/* 使用纯原生的 Three.js Layer 来规避 @react-three/postprocessing Selection Context 死锁 */}
                <Outline visibleEdgeColor={0xffffff} hiddenEdgeColor={0xffffff} edgeStrength={3.0} blur selectionLayer={10} />
            </EffectComposer>

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

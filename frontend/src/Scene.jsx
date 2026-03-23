import React, { Suspense, memo } from 'react';
import { Environment, BakeShadows, GizmoHelper, GizmoViewport, ContactShadows } from '@react-three/drei';
import { useStore } from './store';
import { InteractivePart } from './components/InteractivePart';
import { CameraController } from './CameraController';
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
const PlacementGhost = () => {
    const selectedPort = useStore(s => s.selectedPort);
    const hoveredPort = useStore(s => s.hoveredPort);
    const phase = useStore(s => s.interactionPhase);

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

    return (
        <group position={previewPose.position} quaternion={previewPose.quaternion}>
            <InteractivePart
                partId="ghost"
                ldrawId={selectedPort.ldrawId}
                colorCode={7}
                opacity={0.4}
                transparent={true}
                showPorts={false}
            />
        </group>
    );
};

export default function Scene() {
    const parts = useStore((s) => s.parts);
    const debugMode = useStore((s) => s.debugMode);

    return (
        <>
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

            <CameraController />

            {Object.keys(parts).filter(id => parts[id].zone === ZoneType.ACTIVE_ARENA).map(id => (
                <LegoPart key={id} id={id} />
            ))}

            <PlacementGhost />

            <ContactShadows opacity={0.4} scale={10} blur={2.4} far={0.8} />
            <gridHelper args={[0.5, 30, '#bbb', '#e8e8e8']} position={[0, -0.01, 0]} />

            {debugMode && (
                <axesHelper args={[0.2]} />
            )}

            <BakeShadows />
        </>
    );
}

import { useThree } from '@react-three/fiber';
import { Sphere, Environment, ContactShadows, BakeShadows, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { useMemo, memo } from 'react';
import { useStore } from './store';
import { ZoneType } from './types';
import { CameraController as GenericCameraController } from './CameraController';
import { calculateAssemblyTarget } from './cameraUtils';
import { InteractivePart } from './components/InteractivePart';

// --- Smart Snapping UI ---
const SnappingHighlight = ({ position }) => (
    <Sphere position={position} args={[0.005, 16, 16]}>
        <meshBasicMaterial color="#00ff00" transparent opacity={0.6} />
    </Sphere>
);

// --- Camera Controller 协调逻辑 ---
const AssemblyCameraController = () => {
    const selectedPort = useStore((s) => s.selectedPort);
    const target = useMemo(() => calculateAssemblyTarget(selectedPort), [selectedPort]);
    return <GenericCameraController target={target} minDistance={0.001} maxDistance={1} />;
};

const LegoPart = memo(({ id }) => {
    const state = useStore((s) => s.parts[id]);
    const mode = useStore((s) => s.mode);
    const handlePortClickStore = useStore((s) => s.handlePortClick);
    const showPortGizmos = useStore((s) => s.showPortGizmos);
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
                onDoubleClick={onDoubleClick}
             />
        </group>
    );
});

const ConditionalSSAO = () => {
    const enabled = useStore((s) => s.enableSSAO);
    if (!enabled) return null;
    return (
        <EffectComposer>
            <N8AO aoRadius={0.05} intensity={1.5} distanceFalloff={0.5} />
        </EffectComposer>
    );
};

const ConditionalContactShadows = () => {
    const enabled = useStore((s) => s.enableContactShadows);
    if (!enabled) return null;
    return <ContactShadows position={[0, -0.01, 0]} opacity={0.5} width={0.5} height={0.5} blur={2} far={0.3} />;
};

export default function Scene() {
    const parts = useStore((s) => s.parts);
    const selectedPort = useStore((s) => s.selectedPort);
    const debugMode = useStore((s) => s.debugMode);

    return (
        <>
            <Environment preset="apartment" background={false} />
            <ambientLight intensity={0.4} />
            <directionalLight
                position={[0.8, 1.5, 1.2]}
                intensity={2.0}
                castShadow
                shadow-mapSize-width={1024}
                shadow-mapSize-height={1024}
                shadow-bias={-0.0003}
            />
            <directionalLight position={[-1.2, 0.8, -1.0]} intensity={0.8} />

            <AssemblyCameraController />

            {Object.keys(parts).map(id => (
                <LegoPart key={id} id={id} />
            ))}

            {selectedPort && (
                <SnappingHighlight position={selectedPort.globalPos} />
            )}

            <ConditionalContactShadows />
            <gridHelper args={[0.5, 30, '#bbb', '#e8e8e8']} position={[0, -0.01, 0]} />

            {debugMode && (
                <>
                    <axesHelper args={[0.2]} />
                    <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
                        <GizmoViewport axisColors={['#ff3653', '#0adb50', '#2c8fdf']} labelColor="white" />
                    </GizmoHelper>
                </>
            )}

            <BakeShadows />
            <ConditionalSSAO />
        </>
    );
}

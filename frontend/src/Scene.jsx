import { useFrame, useThree } from '@react-three/fiber';
import { CameraControls, Html, Sphere, Environment, ContactShadows, useGLTF, BakeShadows, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react';
import { useStore } from './store';
import { Vector3, MathUtils } from 'three';
import * as THREE from 'three';
import { useLDrawPart } from './useLDrawPart';
import PropTypes from 'prop-types';
import { CameraController as GenericCameraController } from './CameraController';
import { calculateAssemblyTarget } from './cameraUtils';

const BACKEND_ORIGIN = import.meta.env.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:8000';

// --- Smart Snapping UI ---
const SnappingHighlight = ({ position }) => {
    return (
        <Sphere position={position} args={[0.005, 16, 16]}>
            <meshBasicMaterial color="#00ff00" transparent opacity={0.6} />
            <Html center>
                <div className="bg-green-500 text-white text-xs px-2 py-1 rounded-md shadow-lg font-mono">
                    SNAP TO PORT
                </div>
            </Html>
        </Sphere>
    );
};
SnappingHighlight.propTypes = {
    position: PropTypes.arrayOf(PropTypes.number).isRequired,
};

const createABSPlasticMaterial = (sourceColor, hasVertexColors = false) => {
    const color = hasVertexColors
        ? new THREE.Color(1, 1, 1)
        : (sourceColor instanceof THREE.Color ? sourceColor : new THREE.Color(0xaaaaaa));

    return new THREE.MeshStandardMaterial({
        color,
        roughness: 0.3,
        metalness: 0.0,
        envMapIntensity: 0.8,
        vertexColors: hasVertexColors,
        side: THREE.DoubleSide,
    });
};

// --- LDraw 真实模型渲染组件 ---
const LDrawMeshRenderer = ({ url, setHover, setFocus, id }) => {
    const { scene } = useGLTF(url, true);

    const cloned = useMemo(() => {
        const c = scene.clone(true);
        c.traverse((child) => {
            if (child.isMesh) {
                const hasVC = !!child.geometry?.attributes?.color;
                const origColor = child.material?.color;
                child.material = createABSPlasticMaterial(origColor, hasVC);
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
        return c;
    }, [scene]);

    return (
        <primitive
            object={cloned}
            onPointerOver={(e) => { e.stopPropagation(); setHover(true); }}
            onPointerOut={() => setHover(false)}
            onDoubleClick={(e) => { e.stopPropagation(); setFocus({ partId: id, mode: 'part' }); }}
        />
    );
};
LDrawMeshRenderer.propTypes = {
    url: PropTypes.string.isRequired,
    setHover: PropTypes.func.isRequired,
    setFocus: PropTypes.func.isRequired,
    id: PropTypes.string.isRequired,
};

// --- Camera Controller: 平滑聚焦 + 自动推进 ---
const FOCUS_DISTANCE = 0.2;
const LERP_SPEED = 0.08;

// --- Assembly 专用的摄像机协调逻辑 ---
const AssemblyCameraController = () => {
    const selectedPort = useStore((s) => s.selectedPort);
    
    // 计算当前的聚焦目标：[x, y, z] 或 null
    const target = useMemo(() => {
        return calculateAssemblyTarget(selectedPort);
    }, [selectedPort]);

    return (
        <GenericCameraController 
            target={target} 
            minDistance={0.001} 
            maxDistance={1} 
        />
    );
};

const LDU = 0.0004;
const pitch = 20 * LDU;

const LegoPart = memo(({ id }) => {
    const groupRef = useRef();
    const state = useStore((s) => s.parts[id]);
    const mode = useStore((s) => s.mode);
    const handlePortClickStore = useStore((s) => s.handlePortClick);
    const showPortGizmos = useStore((s) => s.showPortGizmos);
    const setFocus = useStore((s) => s.setFocus);
    const [hovered, setHover] = useState(false);
    const lastPosition = useRef(null);
    const lastQuaternion = useRef(null);

    const partColor = '#b0bec5'; // 默认底色，实际颜色由后端生成的 GLB 网格决定

    const colorCode = state?.colorCode;
    const ldrawPart = useLDrawPart(id, colorCode ?? 7);
    const hasLDrawPorts = ldrawPart.ports && ldrawPart.ports.length > 0;

    const effectivePorts = useMemo(() => {
        const computeQuaternion = (r) => {
            const mat = new THREE.Matrix4().set(
                r[0][0], r[0][1], r[0][2], 0,
                r[1][0], r[1][1], r[1][2], 0,
                r[2][0], r[2][1], r[2][2], 0,
                0, 0, 0, 1
            );
            return new THREE.Quaternion().setFromRotationMatrix(mat);
        };

        if (hasLDrawPorts) {
            return ldrawPart.ports.map((p) => ({
                type: p.type && p.type.toLowerCase().includes('hole') ? 'peghole' : 'peg',
                localPos: p.position,
                rot: p.rotation,
                quaternion: computeQuaternion(p.rotation)
            }));
        }
        return [];
    }, [hasLDrawPorts, ldrawPart.ports]);

    const activeMeshUrl = ldrawPart.meshUrl ? `${BACKEND_ORIGIN}${ldrawPart.meshUrl}` : null;

    useFrame(() => {
        if (!groupRef.current || !state) return;
        const pos = state.position;
        const quat = state.quaternion;
        if (lastPosition.current !== pos) {
            groupRef.current.position.set(pos[0], pos[1], pos[2]);
            lastPosition.current = pos;
        }
        if (lastQuaternion.current !== quat) {
            groupRef.current.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
            lastQuaternion.current = quat;
        }
    });

    const handlePortClick = (e, port) => {
        e.stopPropagation();
        if (mode === 'SIMULATION') return;

        const worldPos = new Vector3(...port.localPos);
        if (groupRef.current) {
            worldPos.applyQuaternion(groupRef.current.quaternion);
            worldPos.add(groupRef.current.position);
        }

        const portInfo = {
            partId: id,
            portType: port.type,
            position: port.localPos,
            rotation: port.rot,
            globalPos: [worldPos.x, worldPos.y, worldPos.z],
        };

        handlePortClickStore(portInfo);
    };

    if (ldrawPart.loading) return null;

    return (
        <group ref={groupRef}>
            {activeMeshUrl ? (
                <LDrawMeshRenderer
                    url={activeMeshUrl}
                    setHover={setHover}
                    setFocus={setFocus}
                    id={id}
                />
            ) : (
                <mesh
                    onPointerOver={() => setHover(true)}
                    onPointerOut={() => setHover(false)}
                    onDoubleClick={() => setFocus({ partId: id, mode: 'part' })}
                >
                    <boxGeometry args={[0.005, 0.005, 0.005]} />
                    <meshBasicMaterial color={hovered ? '#ff9800' : partColor} />
                </mesh>
            )}

            {mode === 'ASSEMBLY' && showPortGizmos && effectivePorts.map((port, idx) => {
                const isHole = port.type === 'peghole';
                const color = isHole ? '#2196f3' : '#e040fb';

                return (
                    <group key={idx} position={port.localPos} quaternion={port.quaternion}>
                        <mesh>
                            <sphereGeometry args={[4 * LDU, 12, 12]} />
                            <meshBasicMaterial
                                color={color}
                                transparent
                                opacity={0.85}
                                depthTest={false}
                            />
                        </mesh>
                        {/* 箭杆：指示插入方向 (局部 Z 轴) */}
                        <mesh position={[0, 0, 3 * LDU]} rotation={[Math.PI / 2, 0, 0]}>
                            <cylinderGeometry args={[0.5 * LDU, 0.5 * LDU, 6 * LDU, 8]} />
                            <meshBasicMaterial
                                color={color}
                                transparent
                                opacity={0.85}
                                depthTest={false}
                            />
                        </mesh>
                        {/* 箭头 */}
                        <mesh position={[0, 0, 8 * LDU]} rotation={[Math.PI / 2, 0, 0]}>
                            <coneGeometry args={[2 * LDU, 4 * LDU, 8]} />
                            <meshBasicMaterial
                                color={color}
                                transparent
                                opacity={0.85}
                                depthTest={false}
                            />
                        </mesh>

                        <mesh
                            renderOrder={999}
                            onClick={(e) => {
                                e.stopPropagation();
                                handlePortClick(e, port);
                            }}
                            onPointerOver={(e) => {
                                e.stopPropagation();
                                document.body.style.cursor = 'pointer';
                            }}
                            onPointerOut={() => {
                                document.body.style.cursor = 'auto';
                            }}
                        >
                            <sphereGeometry args={[12 * LDU, 6, 6]} />
                            <meshBasicMaterial transparent opacity={0} depthTest={false} />
                        </mesh>
                    </group>
                );
            })}
        </group>
    );
});
LegoPart.displayName = 'LegoPart';
LegoPart.propTypes = {
    id: PropTypes.string.isRequired,
};

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
    return (
        <ContactShadows
            position={[0, -0.01, 0]}
            opacity={0.5}
            width={0.5}
            height={0.5}
            blur={2}
            far={0.3}
        />
    );
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
                    <GizmoHelper
                        alignment="bottom-right"
                        margin={[80, 80]}
                    >
                        <GizmoViewport axisColors={['#ff3653', '#0adb50', '#2c8fdf']} labelColor="white" />
                    </GizmoHelper>
                </>
            )}

            <BakeShadows />
            <ConditionalSSAO />
        </>
    );
}

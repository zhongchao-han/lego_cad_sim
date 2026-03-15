import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Sphere, Environment, ContactShadows, useGLTF, BakeShadows } from '@react-three/drei';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react';
import { useStore } from './store';
import { Vector3, MathUtils } from 'three';
import * as THREE from 'three';
import { useLDrawPart } from './useLDrawPart';
import PropTypes from 'prop-types';

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

    const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.3,
        metalness: 0.0,
        envMapIntensity: 0.8,
        vertexColors: hasVertexColors,
    });

    // 存储原始颜色以便根据应力进行插值
    material.userData.originalColor = color.clone();
    return material;
};

// --- LDraw 真实模型渲染组件 ---
const LDrawMeshRenderer = ({ url, setHover, setFocus, id, stress }) => {
    const { scene } = useGLTF(url, true);
    const groupRef = useRef();

    const { cloned, meshList } = useMemo(() => {
        const c = scene.clone(true);
        const meshes = [];
        c.traverse((child) => {
            if (child.isMesh) {
                const hasVC = !!child.geometry?.attributes?.color;
                const origColor = child.material?.color;
                child.material = createABSPlasticMaterial(origColor, hasVC);
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material.userData.originalColor) {
                    meshes.push(child);
                }
            }
        });
        return { cloned: c, meshList: meshes };
    }, [scene]);

    // 根据应力动态变色 (Stress Visualization)
    const stressColor = useMemo(() => new THREE.Color('#ff0000'), []);
    useFrame(() => {
        if (!stress) return;
        const fear = THREE.MathUtils.clamp(stress / 10.0, 0, 1);
        for (let i = 0; i < meshList.length; i++) {
            meshList[i].material.color.lerpColors(
                meshList[i].material.userData.originalColor,
                stressColor,
                fear
            );
        }
    });

    return (
        <primitive
            ref={groupRef}
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
    stress: PropTypes.number,
};

// --- Camera Controller: 平滑聚焦 + 自动推进 ---
const FOCUS_DISTANCE = 0.05;
const LERP_SPEED = 0.08;

const CameraController = () => {
    const controlsRef = useRef();
    const { camera } = useThree();
    const selectedPort = useStore((state) => state.selectedPort);
    const focusedPartId = useStore((state) => state.focusedPartId);
    const enableFocusAnimation = useStore((state) => state.enableFocusAnimation);
    const parts = useStore((state) => state.parts);

    const desiredTarget = useRef(new Vector3());
    const desiredDistance = useRef(null);
    const animating = useRef(false);

    const startFocus = useCallback((pos, dist) => {
        desiredTarget.current.copy(pos);
        desiredDistance.current = dist ?? FOCUS_DISTANCE;
        animating.current = true;
    }, []);

    useEffect(() => {
        if (!selectedPort) return;
        startFocus(new Vector3(...selectedPort.globalPos), FOCUS_DISTANCE);
    }, [selectedPort, startFocus]);

    useEffect(() => {
        if (!focusedPartId) return;
        const partState = parts[focusedPartId];
        if (!partState) return;
        startFocus(new Vector3(...partState.position), FOCUS_DISTANCE);
    }, [focusedPartId, parts, startFocus]);

    useFrame(() => {
        const controls = controlsRef.current;
        if (!controls || !animating.current) return;

        const curTarget = controls.target;
        const desired = desiredTarget.current;

        if (!enableFocusAnimation) {
            curTarget.copy(desired);
            if (desiredDistance.current !== null) {
                const dir = new Vector3().subVectors(camera.position, curTarget).normalize();
                camera.position.copy(curTarget).addScaledVector(dir, desiredDistance.current);
            }
            animating.current = false;
        } else {
            curTarget.lerp(desired, LERP_SPEED);

            if (desiredDistance.current !== null) {
                const dir = new Vector3().subVectors(camera.position, curTarget);
                const curDist = dir.length();
                if (curDist > 0) {
                    dir.normalize();
                    const newDist = MathUtils.lerp(curDist, desiredDistance.current, LERP_SPEED);
                    camera.position.copy(curTarget).addScaledVector(dir, newDist);
                }
            }

            if (curTarget.distanceTo(desired) < 0.0001) {
                animating.current = false;
                desiredDistance.current = null;
            }
        }

        controls.minDistance = 0.01;
        controls.maxDistance = 0.5;
        controls.update();
    });

    return (
        <OrbitControls
            ref={controlsRef}
            makeDefault
            enableDamping
            dampingFactor={0.08}
        />
    );
};

// --- Port Glow: 方案 B 智能孔位发光组件 ---
const PortGlow = ({ type, rotation, hover, active }) => {
    const meshRef = useRef();
    const LDU = 0.0004;

    // 取得 Cyber Cyan (孔) 或 Amber Gold (插销)
    const baseColor = type === 'peghole' ? '#00f2ff' : '#ffab00';

    // 动态脉冲动画
    useFrame((state) => {
        if (!meshRef.current) return;
        if (!hover && !active) return; // 不显示时停止无意义的动画计算
        const t = state.clock.getElapsedTime();
        const pulse = 0.8 + Math.sin(t * 4) * 0.2;
        meshRef.current.material.opacity = 0.9 * pulse;

        // 如果是选中状态，稍微放大一点
        const s = active ? 1.2 : 1.0;
        meshRef.current.scale.set(s, s, s);
    });

    const matrix = useMemo(() => {
        const m = new THREE.Matrix4();
        if (Array.isArray(rotation[0])) {
            // 处理 3x3 嵌套数组
            const r = rotation.flat();
            m.set(
                r[0], r[1], r[2], 0,
                r[3], r[4], r[5], 0,
                r[6], r[7], r[8], 0,
                0, 0, 0, 1
            );
        } else {
            // 处理扁平数组
            const r = rotation;
            m.set(
                r[0], r[1], r[2], 0,
                r[3], r[4], r[5], 0,
                r[6], r[7], r[8], 0,
                0, 0, 0, 1
            );
        }
        return m;
    }, [rotation]);

    // 只有悬停或被选中时才使其可见
    const isVisible = hover || active;

    return (
        <group matrixAutoUpdate={false} onUpdate={(self) => { self.matrix.copy(matrix); }}>
            <mesh ref={meshRef} rotation={[0, 0, 0]} visible={isVisible}>
                {/* 
                 孔深 20 LDU (0.008m)，改为全深度覆盖
                 孔径 6 LDU，使用 5.95 以获得最佳视觉贴合且避免由于极小误差产生的重叠闪烁
                */}
                <cylinderGeometry args={[5.95 * LDU, 5.95 * LDU, 20 * LDU, 24]} />
                <meshBasicMaterial 
                    color={baseColor} 
                    transparent 
                    opacity={0.0} 
                    depthTest={false}
                    blending={THREE.AdditiveBlending}
                />
            </mesh>
        </group>
    );};
PortGlow.propTypes = {
    type: PropTypes.string.isRequired,
    rotation: PropTypes.oneOfType([PropTypes.array, PropTypes.object]).isRequired,
    hover: PropTypes.bool,
    active: PropTypes.bool,
};

const LegoPart = memo(({ id }) => {
    const groupRef = useRef();
    const state = useStore((s) => s.parts[id]);
    const mode = useStore((s) => s.mode);
    const snapParts = useStore((s) => s.snapParts);
    const showPortGizmos = useStore((s) => s.showPortGizmos);
    const setFocus = useStore((s) => s.setFocus);
    const selectedPort = useStore((s) => s.selectedPort);
    const [hovered, setHover] = useState(false);
    const [hoveredPortIdx, setHoveredPortIdx] = useState(null);
    const lastPosition = useRef(null);
    const lastQuaternion = useRef(null);

    const LDU = 0.0004;
    const pitch = 20 * LDU;

    // ... (之前已经有的 fallbackPorts, partColor, ldrawPart 解析逻辑保留)
    const fallbackPorts = useMemo(() => {
        if (['32524', '32523'].includes(id) || id.includes('beam')) {
            const holes = id === '32523' ? 3 : (id === '32524' ? 7 : 5);
            const beamHalfDepth = 10 * LDU;
            return Array.from({ length: holes }, (_, i) => ({
                type: 'peghole',
                localPos: [(-holes / 2 + 0.5 + i) * pitch, beamHalfDepth, 0],
                rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            }));
        } else if (id === '6558' || id.includes('pin')) {
            const pinTip = 30 * LDU;
            return [
                { type: 'peg', localPos: [pinTip, 0, 0], rot: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]] },
                { type: 'peg', localPos: [-pinTip, 0, 0], rot: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] },
            ];
        }
        return [
            { type: 'peghole', localPos: [pitch, 8 * LDU, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
            { type: 'peghole', localPos: [-pitch, 8 * LDU, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
        ];
    }, [id, pitch]);

    const partColor = useMemo(() => {
        if (['32524', '32523'].includes(id) || id.includes('beam')) return '#e53935';
        if (id === '6558' || id.includes('pin')) return '#212121';
        return '#b0bec5';
    }, [id]);

    const colorCode = state?.colorCode;
    const ldrawPart = useLDrawPart(id, colorCode ?? 7);
    const hasLDrawPorts = ldrawPart.ports && ldrawPart.ports.length > 0;

    const effectivePorts = useMemo(() => {
        if (hasLDrawPorts) {
            return ldrawPart.ports.map((p) => ({
                type: p.type && p.type.toLowerCase().includes('hole') ? 'peghole' : 'peg',
                localPos: p.position,
                baseOrigin: p.base_origin || p.position,
                insertionDepth: p.insertion_depth || 0,
                rot: p.rotation,
            }));
        }
        return fallbackPorts.map(p => ({ ...p, baseOrigin: p.localPos, insertionDepth: 0 }));
    }, [hasLDrawPorts, ldrawPart.ports, fallbackPorts]);

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

        const currentSelection = useStore.getState().selectedPort;

        const worldPos = new THREE.Vector3(...port.localPos);
        if (groupRef.current) {
            worldPos.applyQuaternion(groupRef.current.quaternion);
            worldPos.add(groupRef.current.position);
        }

        const portInfo = {
            partId: id,
            portType: port.type,
            position: port.localPos,
            baseOrigin: port.baseOrigin,
            insertionDepth: port.insertionDepth,
            rotation: port.rot,
            globalPos: [worldPos.x, worldPos.y, worldPos.z],
        };

        if (currentSelection && currentSelection.partId !== id) {
            snapParts(currentSelection, portInfo);
        } else {
            useStore.getState().setSelectedPort(portInfo);
        }
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
                    stress={state?.stress}
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
                const isSelected = selectedPort?.partId === id &&
                    selectedPort?.position[0] === port.localPos[0] &&
                    selectedPort?.position[1] === port.localPos[1] &&
                    selectedPort?.position[2] === port.localPos[2];

                return (
                    <group key={idx} position={port.localPos}>
                        <PortGlow
                            type={port.type}
                            rotation={port.rot}
                            hover={hoveredPortIdx === idx}
                            active={isSelected}
                        />

                        {/* 隐形交互球，增大点击面积 */}
                        <mesh
                            renderOrder={999}
                            onClick={(e) => handlePortClick(e, port)}
                            onPointerOver={(e) => {
                                e.stopPropagation();
                                setHoveredPortIdx(idx);
                                document.body.style.cursor = 'pointer';
                            }}
                            onPointerOut={() => {
                                setHoveredPortIdx(null);
                                document.body.style.cursor = 'auto';
                            }}
                        >
                            <sphereGeometry args={[10 * LDU, 6, 6]} />
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

            <CameraController />

            {Object.keys(parts).map(id => (
                <LegoPart key={id} id={id} />
            ))}

            {selectedPort && (
                <SnappingHighlight position={selectedPort.globalPos} />
            )}

            <ConditionalContactShadows />
            <gridHelper args={[0.5, 30, '#bbb', '#e8e8e8']} position={[0, -0.01, 0]} />

            <BakeShadows />
            <ConditionalSSAO />
        </>
    );
}

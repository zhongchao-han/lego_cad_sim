import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Sphere, Environment, ContactShadows, useGLTF } from '@react-three/drei';
import { useEffect, useRef, useState, useMemo } from 'react';
import { useStore } from './store';
import { Vector3 } from 'three';
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

// --- LDraw 真实模型渲染组件 ---
const LDrawMeshRenderer = ({ url, setHover, setFocus, id }) => {
    const { scene } = useGLTF(url, true);
    
    // 遍历子节点设置材质和阴影
    useEffect(() => {
        if (scene) {
            scene.traverse((child) => {
                if (child.isMesh) {
                    // 为 LDraw 转换的模型禁用背面剔除
                    // 这样即使有少量法线不一致的面也不会不可见
                    if (child.material) {
                        child.material.side = THREE.DoubleSide;
                    } else {
                        child.material = new THREE.MeshStandardMaterial({
                            color: 0x999999,
                            side: THREE.DoubleSide,
                        });
                    }
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });
        }
    }, [scene]);

    return (
        <primitive 
            object={scene.clone()}
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

// --- Camera Anchor Lock + 聚焦模式 ---
const CameraController = () => {
    const controlsRef = useRef();
    const { camera } = useThree();
    const selectedPort = useStore((state) => state.selectedPort);
    const focusedPartId = useStore((state) => state.focusedPartId);
    const focusMode = useStore((state) => state.focusMode);
    const enableFocusAnimation = useStore((state) => state.enableFocusAnimation);
    const parts = useStore((state) => state.parts);

    const targetRef = useRef(new Vector3());
    const hasTargetRef = useRef(false);

    useEffect(() => {
        if (!selectedPort || !controlsRef.current) return;
        // 端口聚焦：把目标设置为端口世界坐标
        const targetPos = new Vector3(...selectedPort.globalPos);
        targetRef.current.copy(targetPos);
        hasTargetRef.current = true;
    }, [selectedPort]);

    useEffect(() => {
        if (!focusedPartId || !controlsRef.current) return;
        const partState = parts[focusedPartId];
        if (!partState) return;
        // 零件聚焦：简单使用刚体位置作为聚焦中心
        const targetPos = new Vector3(...partState.position);
        targetRef.current.copy(targetPos);
        hasTargetRef.current = true;
    }, [focusedPartId, parts]);

    useFrame(() => {
        const controls = controlsRef.current;
        if (!controls || !hasTargetRef.current) return;

        const currentTarget = controls.target;
        const desired = targetRef.current;

        // 记录当前视距与方向
        const offset = new Vector3().subVectors(camera.position, currentTarget);
        const distance = offset.length();
        if (distance === 0) return;
        const dir = offset.normalize();

        if (!enableFocusAnimation) {
            // 无动画：直接跳转
            currentTarget.copy(desired);
        } else {
            // 带动画：缓动插值
            currentTarget.lerp(desired, 0.12);
        }

        const newPos = new Vector3().addVectors(currentTarget, dir.clone().multiplyScalar(distance));
        camera.position.copy(newPos);
        controls.minDistance = 0.02;
        controls.maxDistance = 0.5;
        controls.update();
    });

    return <OrbitControls ref={controlsRef} makeDefault />;
};

// --- 独立乐高零件呈现 ---
const LegoPart = ({ id }) => {
    const groupRef = useRef();
    const state = useStore((state) => state.parts[id]);
    const mode = useStore((state) => state.mode);
    const snapParts = useStore((state) => state.snapParts);
    const showPortGizmos = useStore((state) => state.showPortGizmos);
    const setFocus = useStore((state) => state.setFocus);
    const [hovered, setHover] = useState(false);

    const LDU = 0.0004;
    const pitch = 20 * LDU;

    // fallback 端口定义（当 LDraw 未提供端口时使用）
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
            // LDraw 6558 网格沿 X 轴延伸 (-30 ~ +30 LDU)
            // 端口放在两端尖端，旋转矩阵让 baseAxis [0,1,0] 映射到 X 轴方向
            const pinTip = 30 * LDU; // 0.012m
            return [
                { type: 'peg', localPos: [pinTip, 0, 0],  rot: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]] },
                { type: 'peg', localPos: [-pinTip, 0, 0], rot: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] },
            ];
        }
        return [
            { type: 'peghole', localPos: [pitch, 8 * LDU, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
            { type: 'peghole', localPos: [-pitch, 8 * LDU, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
            { type: 'peghole', localPos: [0, 8 * LDU, pitch], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
            { type: 'peghole', localPos: [0, 8 * LDU, -pitch], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
        ];
    }, [id]);

    const partColor = useMemo(() => {
        if (['32524', '32523'].includes(id) || id.includes('beam')) return '#e53935';
        if (id === '6558' || id.includes('pin')) return '#212121';
        return '#b0bec5';
    }, [id]);

    const ldrawPart = useLDrawPart(id);
    const hasLDrawPorts = ldrawPart.ports && ldrawPart.ports.length > 0;

    const effectivePorts = useMemo(() => {
        if (hasLDrawPorts) {
            return ldrawPart.ports.map((p) => ({
                type: p.type && p.type.toLowerCase().includes('hole') ? 'peghole' : 'peg',
                localPos: p.position,
                rot: p.rotation,
            }));
        }
        return fallbackPorts;
    }, [hasLDrawPorts, ldrawPart.ports, fallbackPorts]);

    const activeMeshUrl = ldrawPart.meshUrl ? `${BACKEND_ORIGIN}${ldrawPart.meshUrl}` : null;

    useFrame(() => {
        if (groupRef.current && state) {
            groupRef.current.position.set(...state.position);
            groupRef.current.quaternion.set(...state.quaternion);
        }
    });

    const handlePortClick = (e, port) => {
        e.stopPropagation();
        if (mode === 'SIMULATION') return;

        const currentSelection = useStore.getState().selectedPort;

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

        if (currentSelection && currentSelection.partId !== id) {
            console.log(`🔗 Snapping ${currentSelection.partId} → ${id}...`);
            snapParts(currentSelection, portInfo);
        } else {
            console.log(`🎯 已选中端口: ${id} [${port.type}] @ [${worldPos.x.toFixed(4)}, ${worldPos.y.toFixed(4)}, ${worldPos.z.toFixed(4)}]`);
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

            {/* 渲染可交互端口 - 蓝色=销孔(peghole)，品红=销钉端(peg) */}
            {/* 每个端口由一个可见的小球 + 一个更大的透明命中区域组成 */}
            {mode === 'ASSEMBLY' && showPortGizmos && effectivePorts.map((port, idx) => (
                <group key={idx} position={port.localPos}>
                    {/* 可见的端口指示球 */}
                    <mesh>
                        <sphereGeometry args={[4 * LDU, 16, 16]} />
                        <meshBasicMaterial
                            color={port.type === 'peghole' ? '#2196f3' : '#e040fb'}
                            transparent
                            opacity={0.85}
                            depthTest={false}
                        />
                    </mesh>
                    {/* 更大的透明点击热区 (半径 = 12 LDU ≈ 5mm，屏幕上约 15-20px) */}
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
                        <sphereGeometry args={[12 * LDU, 8, 8]} />
                        <meshBasicMaterial transparent opacity={0} depthTest={false} />
                    </mesh>
                </group>
            ))}
        </group>
    );
};
LegoPart.propTypes = {
    id: PropTypes.string.isRequired,
};

export default function Scene() {
    const parts = useStore((state) => state.parts);
    const selectedPort = useStore((state) => state.selectedPort);

    return (
        <>
            {/* 环境光与环境贴图 */}
            <ambientLight intensity={0.5} />
            <Environment preset="studio" background={false} />

            {/* 主光与辅光 */}
            <directionalLight
                position={[1, 2, 3]}
                intensity={1.6}
                castShadow
                shadow-mapSize-width={2048}
                shadow-mapSize-height={2048}
                shadow-bias={-0.0005}
            />
            <directionalLight position={[-2, 1, -1]} intensity={0.5} />

            <CameraController />

            {Object.keys(parts).map(id => (
                <LegoPart key={id} id={id} />
            ))}

            {selectedPort && (
                <SnappingHighlight position={selectedPort.globalPos} />
            )}

            <ContactShadows
                position={[0, -0.01, 0]}
                opacity={0.4}
                width={0.4}
                height={0.4}
                blur={2.5}
                far={0.3}
            />
            <gridHelper args={[0.5, 30, '#999', '#ddd']} position={[0, -0.01, 0]} />
        </>
    );
}

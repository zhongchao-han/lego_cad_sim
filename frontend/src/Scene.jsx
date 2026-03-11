import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Sphere, Environment, ContactShadows } from '@react-three/drei';
import { useEffect, useRef, useState, useMemo } from 'react';
import { useStore } from './store';
import { Vector3 } from 'three';
import * as THREE from 'three';
import { useLDrawPart } from './useLDrawPart';

// ============= Lego Technic 梁 (Beam) 几何体生成器 =============
// 生成一个带有圆孔阵列的 Technic 梁形状
function createBeamGeometry(holes = 5) {
    const LDU = 0.0004; // 1 LDU = 0.4mm
    const pitch = 20 * LDU; // 孔间距 8mm
    const width = pitch * holes;
    const height = 20 * LDU; // 8mm
    const depth = 20 * LDU; // 8mm
    const holeRadius = 6 * LDU; // 2.4mm 半径

    const shape = new THREE.Shape();
    const r = 4 * LDU; // 圆角半径
    const hw = width / 2;
    const hh = height / 2;

    // 带圆角的矩形外轮廓
    shape.moveTo(-hw + r, -hh);
    shape.lineTo(hw - r, -hh);
    shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
    shape.lineTo(hw, hh - r);
    shape.quadraticCurveTo(hw, hh, hw - r, hh);
    shape.lineTo(-hw + r, hh);
    shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
    shape.lineTo(-hw, -hh + r);
    shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);

    // 在每个孔位处掏出圆形孔洞
    for (let i = 0; i < holes; i++) {
        const cx = -hw + pitch / 2 + i * pitch;
        const holePath = new THREE.Path();
        holePath.absarc(cx, 0, holeRadius, 0, Math.PI * 2, true);
        shape.holes.push(holePath);
    }

    const extrudeSettings = {
        steps: 1,
        depth: depth,
        bevelEnabled: true,
        bevelThickness: 1.5 * LDU,
        bevelSize: 1.5 * LDU,
        bevelSegments: 2,
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    // 居中
    geometry.translate(0, 0, -depth / 2);
    // 旋转使其水平放置 (Z轴朝上变成Y轴朝上)
    geometry.rotateX(Math.PI / 2);

    return geometry;
}

// ============= Lego Technic 销钉 (Pin) 几何体 =============
function createPinGeometry() {
    const LDU = 0.0004;
    const pinRadius = 6 * LDU; // 2.4mm 半径
    const pinLength = 32 * LDU; // 12.8mm 总长 (大约两个板厚)
    const grooveDepth = 1 * LDU;
    const grooveWidth = 2 * LDU;

    const group = new THREE.Group();

    // 主体圆柱
    const bodyGeo = new THREE.CylinderGeometry(pinRadius, pinRadius, pinLength, 16);
    bodyGeo.rotateZ(Math.PI / 2); // 使其横向

    // 中间凸缘
    const flangeGeo = new THREE.CylinderGeometry(pinRadius + 2 * LDU, pinRadius + 2 * LDU, 3 * LDU, 16);
    flangeGeo.rotateZ(Math.PI / 2);

    return { bodyGeo, flangeGeo };
}

// ============= Lego 基板 (Plate / Base Link) =============
function createPlateGeometry() {
    const LDU = 0.0004;
    const width = 80 * LDU; // 32mm
    const height = 8 * LDU; // 3.2mm (一个薄板)
    const depth = 80 * LDU; // 32mm

    const geometry = new THREE.BoxGeometry(width, height, depth);
    // 顶部加些圆形凸起当作 Stud
    return geometry;
}

// --- 通用乐高塑料材质 ---
const LegoPlasticMaterial = ({ color }) => {
    return (
        <meshPhysicalMaterial
            color={color}
            roughness={0.28}
            metalness={0.02}
            clearcoat={0.7}
            clearcoatRoughness={0.25}
            envMapIntensity={0.9}
        />
    );
};

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

        const newPos = new Vector3().addVectors(currentTarget, dir.multiplyScalar(distance));
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
    const useLDraw = useStore((state) => state.useLDraw);
    const showPortGizmos = useStore((state) => state.showPortGizmos);
    const setFocus = useStore((state) => state.setFocus);
    const [hovered, setHover] = useState(false);

    const LDU = 0.0004;
    const pitch = 20 * LDU;

    // 确定零件类型和参数
    const partConfig = useMemo(() => {
        if (id.includes('beam')) {
            const holes = 5;
            return {
                type: 'beam',
                holes,
                geometry: createBeamGeometry(holes),
                color: '#e53935', // 乐高经典红
                hoverColor: '#ff9800',
                ports: Array.from({ length: holes }, (_, i) => ({
                    type: 'peghole',
                    localPos: [(-holes / 2 + 0.5 + i) * pitch, 6 * LDU, 0], // Y偏移：浮在梁上方
                    rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                })),
            };
        } else if (id.includes('pin')) {
            return {
                type: 'pin',
                geometry: null, // 使用内联几何体
                color: '#212121', // 黑色销钉
                hoverColor: '#ff9800',
                ports: [
                    { type: 'peg', localPos: [0, 16 * LDU, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
                    { type: 'peg', localPos: [0, -16 * LDU, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
                ],
            };
        } else {
            return {
                type: 'plate',
                geometry: createPlateGeometry(),
                color: '#b0bec5', // 浅灰色底座
                hoverColor: '#ff9800',
                ports: [
                    { type: 'peghole', localPos: [pitch, 8 * LDU, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
                    { type: 'peghole', localPos: [-pitch, 8 * LDU, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
                    { type: 'peghole', localPos: [0, 8 * LDU, pitch], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
                    { type: 'peghole', localPos: [0, 8 * LDU, -pitch], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
                ],
            };
        }
    }, [id]);

    // LDraw 端口语义（当 useLDraw 为 true 时尝试从后端获取）
    const ldrawPart = useLDrawPart(useLDraw ? id : null);

    const effectivePorts = useMemo(() => {
        if (useLDraw && ldrawPart.ports && ldrawPart.ports.length > 0) {
            return ldrawPart.ports.map((p) => ({
                type: p.type && p.type.toLowerCase().includes('hole') ? 'peghole' : 'peg',
                localPos: p.position,
                rot: p.rotation,
            }));
        }
        return partConfig.ports;
    }, [useLDraw, ldrawPart.ports, partConfig.ports]);

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

    const currentColor = hovered ? partConfig.hoverColor : partConfig.color;

    return (
        <group ref={groupRef}>
            {/* 主体几何体 */}
            {partConfig.type === 'beam' && (
                <mesh
                    geometry={partConfig.geometry}
                    onPointerOver={() => setHover(true)}
                    onPointerOut={() => setHover(false)}
                    onDoubleClick={() => setFocus({ partId: id, mode: 'part' })}
                >
                    <LegoPlasticMaterial color={currentColor} />
                </mesh>
            )}

            {partConfig.type === 'pin' && (
                <group
                    onPointerOver={() => setHover(true)}
                    onPointerOut={() => setHover(false)}
                    onDoubleClick={() => setFocus({ partId: id, mode: 'part' })}
                >
                    {/* 销钉主体 */}
                    <mesh>
                        <cylinderGeometry args={[6 * LDU, 6 * LDU, 32 * LDU, 16]} />
                        <LegoPlasticMaterial color={currentColor} />
                    </mesh>
                    {/* 中部凸缘 */}
                    <mesh>
                        <cylinderGeometry args={[8 * LDU, 8 * LDU, 3 * LDU, 16]} />
                        <LegoPlasticMaterial color={currentColor} />
                    </mesh>
                </group>
            )}

            {partConfig.type === 'plate' && (
                <group
                    onPointerOver={() => setHover(true)}
                    onPointerOut={() => setHover(false)}
                    onDoubleClick={() => setFocus({ partId: id, mode: 'part' })}
                >
                    <mesh geometry={partConfig.geometry}>
                        <LegoPlasticMaterial color={currentColor} />
                    </mesh>
            {/* Technic 底板上的 4 个螺纹孔标记（浅色凹陷） */}
                    {partConfig.ports.map((port, i) => (
                        <mesh key={`hole-${i}`} position={[port.localPos[0], 4 * LDU + 0.5 * LDU, port.localPos[2]]}>
                            <cylinderGeometry args={[5 * LDU, 5 * LDU, 1 * LDU, 16]} />
                            <meshStandardMaterial color="#90a4ae" roughness={0.5} />
                        </mesh>
                    ))}
                </group>
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

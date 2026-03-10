import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Sphere, TransformControls } from '@react-three/drei';
import { useEffect, useRef, useState, useMemo } from 'react';
import { useStore } from './store';
import { Vector3, Matrix4 } from 'three';

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

// --- Camera Anchor Lock ---
const CameraController = () => {
    const { camera } = useThree();
    const controlsRef = useRef();
    const selectedPort = useStore((state) => state.selectedPort);

    useEffect(() => {
        if (selectedPort && controlsRef.current) {
            // 当选择了特定的孔洞后，缓动相机锁定并以此孔位作为 Orbit 中心
            const targetPos = new Vector3(...selectedPort.globalPos);
            controlsRef.current.target.copy(targetPos);
            controlsRef.current.minDistance = 0.05; // 允许推进更深聚焦细节
            controlsRef.current.maxDistance = 0.5;
        }
    }, [selectedPort]);

    return <OrbitControls ref={controlsRef} makeDefault />;
};

// --- 独立乐高零件呈现 ---
const LegoPart = ({ id }) => {
    const meshRef = useRef();
    const state = useStore((state) => state.parts[id]);
    const mode = useStore((state) => state.mode);
    const snapParts = useStore((state) => state.snapParts);
    const [hovered, setHover] = useState(false);

    // 假想这个件有两个备用的装配端口
    const dummyPorts = useMemo(() => [
        { type: 'peghole', localPos: [0.015, 0, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
        { type: 'axlehole', localPos: [-0.015, 0, 0], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }
    ], []);

    useFrame(() => {
        // 无论是仿真推流过来的位置，还是在组装时拖拽的局部参数，都一并在每帧向 Mesh 对齐
        if (meshRef.current && state) {
            meshRef.current.position.set(...state.position);
            meshRef.current.quaternion.set(...state.quaternion);
        }
    });

    const handlePortClick = (e, port) => {
        e.stopPropagation();
        if (mode === 'SIMULATION') return; // 在仿真态不让编辑

        const currentSelection = useStore.getState().selectedPort;

        // 计算此端口在此刻组件朝向下的绝对世界位置（用于连线和聚焦）
        const worldPos = new Vector3(...port.localPos)
            .applyQuaternion(meshRef.current.quaternion)
            .add(meshRef.current.position);

        const portInfo = {
            partId: id,
            portType: port.type,
            position: port.localPos,
            rotation: port.rot,
            globalPos: [worldPos.x, worldPos.y, worldPos.z]
        };

        if (currentSelection && currentSelection.partId !== id) {
            // 存在其它件的待吸附端点了，尝试合拢并发送到后端建立边
            console.log(`Snapping ${currentSelection.partId} to ${id}...`);
            snapParts(currentSelection, portInfo);
        } else {
            // 作为发起端被选中
            useStore.getState().setSelectedPort(portInfo);
        }
    };

    // 根据组件名称使用简单的颜色作为占位
    const color = id === 'base_link' ? '#cfd8dc' : id.includes('pin') ? '#212121' : '#f44336';

    return (
        <group>
            <mesh ref={meshRef}
                onPointerOver={() => setHover(true)}
                onPointerOut={() => setHover(false)}>
                {/* Placeholder Box Geometry matching SI units (eg: 0.05m = 5cm) */}
                <boxGeometry args={[0.04, 0.008, 0.008]} />
                <meshStandardMaterial color={hovered ? '#ff9800' : color} roughness={0.3} metalness={0.1} />
            </mesh>

            {/* 渲染依附在件上的虚拟端口，当且仅当 Assembly 模式 */}
            {mode === 'ASSEMBLY' && dummyPorts.map((port, idx) => (
                <Sphere
                    key={idx}
                    position={port.localPos}
                    args={[0.002, 8, 8]}
                    onClick={(e) => handlePortClick(e, port)}
                    onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                    onPointerOut={() => document.body.style.cursor = 'auto'}
                >
                    <meshBasicMaterial color={port.type === 'peghole' ? '#2196f3' : '#9c27b0'} />
                </Sphere>
            ))}
        </group>
    );
};

export default function Scene() {
    const parts = useStore((state) => state.parts);
    const selectedPort = useStore((state) => state.selectedPort);

    return (
        <>
            <ambientLight intensity={0.5} />
            <directionalLight position={[1, 2, 3]} intensity={1.5} castShadow />

            <CameraController />

            {/* 渲染所有存在的乐高件及其内置端口 */}
            {Object.keys(parts).map(id => (
                <LegoPart key={id} id={id} />
            ))}

            {/* 跨部件全局显示拖拽的落点射线/高亮 */}
            {selectedPort && (
                <SnappingHighlight position={selectedPort.globalPos} />
            )}

            {/* 基础网格地皮 */}
            <gridHelper args={[1, 20]} position={[0, -0.01, 0]} />
        </>
    );
}

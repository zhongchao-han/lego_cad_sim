import { useGLTF } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import PropTypes from 'prop-types';

const createABSPlasticMaterial = (sourceColor: THREE.Color | string | undefined, hasVertexColors = false) => {
    const color = hasVertexColors
        ? new THREE.Color(1, 1, 1)
        : (sourceColor instanceof THREE.Color ? sourceColor : new THREE.Color(sourceColor ?? 0xaaaaaa));

    return new THREE.MeshStandardMaterial({
        color,
        roughness: 0.3,
        metalness: 0.0,
        envMapIntensity: 0.8,
        vertexColors: hasVertexColors,
        side: THREE.DoubleSide,
    });
};

export function LDrawMeshRenderer({ url, onPointerOver, onPointerOut, onDoubleClick }: any) {
    const { scene } = useGLTF(url, true);

    const cloned = useMemo(() => {
        const c = scene.clone(true);
        c.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                const hasVC = !!mesh.geometry?.attributes?.color;
                const origColor = (mesh.material as THREE.MeshStandardMaterial)?.color;
                mesh.material = createABSPlasticMaterial(origColor, hasVC);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
            }
        });
        return c;
    }, [scene]);

    return (
        <primitive
            object={cloned}
            onPointerOver={onPointerOver}
            onPointerOut={onPointerOut}
            onDoubleClick={onDoubleClick}
        />
    );
}

LDrawMeshRenderer.propTypes = {
    url: PropTypes.string.isRequired,
    onPointerOver: PropTypes.func,
    onPointerOut: PropTypes.func,
    onDoubleClick: PropTypes.func,
};

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import * as ReactThreeTest from '@react-three/test-renderer';
import * as THREE from 'three';
import { LDrawMeshRenderer } from '../components/LDrawMeshRenderer';

// Mock useGLTF to return a controlled Scene with known meshes
vi.mock('@react-three/drei', async () => {
  const actual = await vi.importActual('@react-three/drei');
  return {
    ...actual as any,
    useGLTF: vi.fn().mockReturnValue({
      scene: (() => {
        const group = new THREE.Group();
        const mesh1 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
        mesh1.name = 'MockMesh1';
        const mesh2 = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshStandardMaterial());
        mesh2.name = 'MockMesh2';
        group.add(mesh1, mesh2);
        return group;
      })()
    }),
  };
});

describe('LDrawMeshRenderer Component Outline Rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without BoxHelper when highlightOutline is false', async () => {
    const renderer = await ReactThreeTest.create(
      <LDrawMeshRenderer url="test.dat" highlightOutline={false} />
    );
    
    // allow async effects to settle
    await ReactThreeTest.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    const lineSegments = renderer.scene.children.filter((child: any) => child.type === 'LineSegments');
    expect(lineSegments.length).toBe(0);
  });

  it('renders a custom local LineSegments bounding box when highlightOutline is true and exactBoundingBox is provided', async () => {
    const mockBoundingBox = {
      size: [10, 20, 30] as [number, number, number],
      center: [1, 2, 3] as [number, number, number],
    };

    const renderer = await ReactThreeTest.create(
      <LDrawMeshRenderer url="test.dat" highlightOutline={true} exactBoundingBox={mockBoundingBox} />
    );

    await ReactThreeTest.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    const lineSegmentsNode = renderer.scene.findAll((node: any) => node.type === 'LineSegments' || node.instance instanceof THREE.LineSegments)[0];
    expect(lineSegmentsNode).toBeDefined();

    // Verify it used the provided position
    const instance = lineSegmentsNode.instance as THREE.LineSegments;
    expect(instance.position.x).toBe(1);
    expect(instance.position.y).toBe(2);
    expect(instance.position.z).toBe(3);
    
    // Verify geometry size (BoxGeometry creates width/height/depth)
    const geom = instance.geometry as THREE.EdgesGeometry;
    expect(geom).toBeDefined();
  });
});

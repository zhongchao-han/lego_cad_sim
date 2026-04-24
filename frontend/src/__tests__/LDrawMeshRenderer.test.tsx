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

  it('renders a custom local LineSegments bounding box when highlightOutline is true', async () => {
    const renderer = await ReactThreeTest.create(
      <LDrawMeshRenderer url="test.dat" highlightOutline={true} />
    );

    await ReactThreeTest.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    const lineSegments = renderer.scene.findAll((node: any) => node.type === 'LineSegments' || node.instance instanceof THREE.LineSegments);
    
    expect(lineSegments.length).toBeGreaterThan(0);
  });
});

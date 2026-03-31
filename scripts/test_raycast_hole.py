import sys
import os
sys.path.insert(0, os.getcwd())
import numpy as np
import trimesh
from backend.geometry_processor import GeometryProcessor
import backend.geometry_processor as gp_module

# Enable the new primitives
gp_module.SEMANTIC_PRIMITIVES.extend(['npeghol2.dat', 'npeghol19.dat', 'npeghol9.dat', 'connhol2.dat'])
gp_module.CONNECTOR_PREFIXES.extend(['npeghol', 'connhol'])
gp_module.GeometryProcessor.discover_ports.__globals__['THROUGH_HOLES'] = ['beamhole.dat', 'connhole.dat', 'crosshole.dat', 'connhol2.dat']
gp_module.GeometryProcessor.discover_ports.__globals__['BLIND_HOLES'] = ['peghole.dat', 'halfhole.dat', 'npeghol9.dat', 'npeghol2.dat', 'npeghol19.dat']

gp = GeometryProcessor(ldraw_path='ldraw_lib')

# Get vertices and build mesh
vertices, faces, _ = gp.extract_geometry('64179.dat', parent_color_code=7)
mesh = trimesh.Trimesh(vertices=np.array(vertices), faces=np.array(faces), process=False)
print(f"Mesh loaded: {len(mesh.vertices)} vertices, {len(mesh.faces)} faces.")

# Extract ports
ports = gp.discover_ports('64179.dat')
print(f"Extracted {len(ports)} raw ports.")

# Filter for the blind holes we want to test
test_ports = [p for p in ports if p['type'] in gp_module.GeometryProcessor.discover_ports.__globals__['BLIND_HOLES']]
print(f"Found {len(test_ports)} blind-hole candidates.")

# Test Raycast for the first few ports
for i, port in enumerate(test_ports[:5]):
    # Note: port positions are in SI scaled, and Y/Z swapped!
    # Let's just use the raw LDraw matrices by re-running discover_ports manually?
    # No, we can reverse the SI scaling to get LDraw coordinates!
    
    # Or better, let's run raycasting in SI space!
    # mesh in SI space
    verts_si = (gp_module.CoordinateTransformer.get_rx180() @ np.array(vertices).T).T * gp_module.CoordinateTransformer.LDU_TO_SI
    mesh_si = trimesh.Trimesh(vertices=verts_si, faces=mesh.faces, process=False)
    
    pos = np.array(port['position'])
    rot = np.array(port['rotation'])
    
    # The port's normal is the -Z axis of the rotation matrix (since Z points OUTWARD)
    # Wait, in the port framework, Z axis points OUT OF the hole.
    # So the INWARD direction is -Z.
    inward_dir = -rot[:, 2]
    
    # Epsilon offset to avoid self-intersection with the opening polygon
    ray_origins = [pos + inward_dir * 0.0001]
    ray_dirs = [inward_dir]
    
    locations, index_ray, index_tri = mesh_si.ray.intersects_location(
        ray_origins=ray_origins,
        ray_directions=ray_dirs
    )
    
    if len(locations) > 0:
        # Distance to the FIRST hit
        distances = np.linalg.norm(locations - ray_origins[0], axis=1)
        # Sort by distance just in case
        first_hit = np.min(distances)
        # Convert distance back to LDU
        hit_ldu = first_hit / gp_module.CoordinateTransformer.LDU_TO_SI
        print(f"Port {i} ({port['type']}): Raycast hit at {hit_ldu:.2f} LDU inward.")
    else:
        print(f"Port {i} ({port['type']}): Raycast hit NOTHING.")

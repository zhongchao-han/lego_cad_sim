import sys
import os
import json
import logging
sys.path.insert(0, os.getcwd())

from backend.geometry_processor import GeometryProcessor
from backend.site_utils import cluster_ports_into_sites, sites_to_response

logging.basicConfig(level=logging.DEBUG)

def test_64179_end_to_end():
    print("=== BEGIN TEST 64179 ===")
    geo_proc = GeometryProcessor(ldraw_path='ldraw_lib')
    
    # 1. Extraction
    ports = geo_proc.discover_ports('64179.dat')
    print(f"Total raw ports extracted: {len(ports)}")
    
    healed_ports = [p for p in ports if 'healed' in p['name']]
    print(f"Total healed ports: {len(healed_ports)}")
    
    # 2. Clustering
    sites = cluster_ports_into_sites(ports, 'parts/64179.dat')
    print(f"Total sites clustered: {len(sites)}")
    
    site_resp = sites_to_response(sites)
    
    # Let's see if the healed ports made it into the Sites response!
    healed_sites_count = 0
    for s in site_resp:
        has_healed = any('healed' in p['name'] for p in s['ports'])
        if has_healed:
            healed_sites_count += 1
            print(f"Healed Site found: pos={s['position']}")
            for p in s['ports']:
                print(f"  Port: {p['name']}, type={p['type']}, rot_z={p['rotation'][2]}")
                
    print(f"Total sites containing healed ports: {healed_sites_count}")
    assert healed_sites_count == 12, f"Expected 12 healed sites, got {healed_sites_count}"

if __name__ == '__main__':
    test_64179_end_to_end()

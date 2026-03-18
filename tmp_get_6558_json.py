
import numpy as np
import os
from ldraw_parser import LDrawParser
from port import Port
import json

LDRAW_PARTS_ROOT = "ldraw_lib"
parser = LDrawParser(ldraw_path=LDRAW_PARTS_ROOT)

part_id = "6558"
dat_filename = "6558.dat"

parsed_ports = parser.parse_dat_file(dat_filename)
ports_data = [p.to_dict() for p in parsed_ports]

print(json.dumps(ports_data, indent=2))

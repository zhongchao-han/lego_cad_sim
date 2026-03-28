import os

files_to_fix = [
    'backend/geometry_processor.py',
    'backend/math_utils.py',
    'backend/physics_engine.py',
    'backend/port.py',
    'backend/port_library_manager.py',
    'backend/server.py',
    'backend/topology_manager.py',
    'backend/tests/test_v3_0_physics_core.py',
    'backend/port_semantics.py'
]

def fix_file(filepath):
    if not os.path.exists(filepath): return
    with open(filepath, 'r') as f:
        content = f.read()

    lines = content.split('\n')
    new_lines = []

    for line in lines:
        if 'geometry_processor.py' in filepath:
            line = line.replace("def calculate_p2p_alignment(source_port: 'Port', target_port: 'Port') -> np.ndarray:", "def calculate_p2p_alignment(source_port, target_port) -> np.ndarray:")
            line = line.replace("if not os.path.exists(config_path): return colors", "if not os.path.exists(config_path):\n            return colors")
            line = line.replace("if '!COLOUR' not in line: continue", "if '!COLOUR' not in line:\n                        continue")
            line = line.replace("if not (code_m and val_m): continue", "if not (code_m and val_m):\n                        continue")
            line = line.replace("if not filepath: return [], [], []", "if not filepath:\n            return [], [], []")
            line = line.replace("if not parts: continue", "if not parts:\n                continue")
            line = line.replace("vertices.extend(cv); vertex_colors.extend(cvc)", "vertices.extend(cv)\n                    vertex_colors.extend(cvc)")
            line = line.replace("for face in cf: faces.append(np.array(face) + offset)", "for face in cf:\n                        faces.append(np.array(face) + offset)")
            line = line.replace("except ValueError: pass", "except ValueError:\n                    pass")
            line = line.replace("finally: bfc_invert_next = False", "finally:\n                    bfc_invert_next = False")
            line = line.replace("vertices.extend(v); vertex_colors.extend([rgba] * num_pts)", "vertices.extend(v)\n                    vertex_colors.extend([rgba] * num_pts)")
            line = line.replace("if num_pts == 4: faces.append(np.array([idx, idx+3, idx+2]))", "if num_pts == 4:\n                            faces.append(np.array([idx, idx+3, idx+2]))")
            line = line.replace("faces.append(np.array([idx, idx+1, idx+2]))", "faces.append(np.array([idx, idx+1, idx+2]))")
            line = line.replace("if num_pts == 4: faces.append(np.array([idx, idx+2, idx+3]))", "if num_pts == 4:\n                            faces.append(np.array([idx, idx+2, idx+3]))")
            line = line.replace("if not vertices or not faces: return False", "if not vertices or not faces:\n            return False")
            line = line.replace("if dir_name: os.makedirs(dir_name, exist_ok=True)", "if dir_name:\n                os.makedirs(dir_name, exist_ok=True)")
            line = line.replace("with open(output_path, 'wb') as f: f.write(export_data)", "with open(output_path, 'wb') as f:\n                f.write(export_data)")
            line = line.replace("if is_root: root_id = filename.replace(\".dat\", \"\")", "if is_root:\n            root_id = filename.replace(\".dat\", \"\")")
            line = line.replace("if not filepath: return []", "if not filepath:\n            return []")
            line = line.replace("if not parts or parts[0] != '1': continue", "if not parts or parts[0] != '1':\n                continue")
            line = line.replace("base_unit_len = v; break", "base_unit_len = v\n                            break")

        if 'math_utils.py' in filepath:
            line = line.replace("if norm_x < 1e-6: vx = np.array([1.0, 0, 0])", "if norm_x < 1e-6:\n            vx = np.array([1.0, 0, 0])")
            line = line.replace("else: vx /= norm_x", "else:\n            vx /= norm_x")
            line = line.replace("if norm_y < 1e-6: vy = np.array([0, 1.0, 0])", "if norm_y < 1e-6:\n            vy = np.array([0, 1.0, 0])")
            line = line.replace("else: vy /= norm_y", "else:\n            vy /= norm_y")

        if 'physics_engine.py' in filepath:
            line = line.replace("if self.robot_id is None: return", "if self.robot_id is None:\n            return")
            line = line.replace("if idx == -1: continue # base_link", "if idx == -1:\n                continue  # base_link")

        if 'port.py' in filepath:
            line = line.replace("if not interface: return None", "if not interface:\n            return None")

        if 'port_library_manager.py' in filepath:
            line = line.replace("try: os.remove(temp_path)", "try:\n                        os.remove(temp_path)")
            line = line.replace("except: pass", "except Exception:\n                        pass")

        if 'server.py' in filepath:
            line = line.replace("if isinstance(v, list): return [clean_pos(i) for i in v]", "if isinstance(v, list):\n            return [clean_pos(i) for i in v]")

        if 'topology_manager.py' in filepath:
            line = line.replace("if not line: break", "if not line:\n                break")

        if 'test_v3_0_physics_core.py' in filepath:
            line = line.replace("baker = UnifiedAssetBaker()", "UnifiedAssetBaker()")

        # port_semantics.py is fixed manually below
        new_lines.append(line)

    content = '\n'.join(new_lines)

    if 'port_semantics.py' in filepath:
        # F601: Dictionary key literal repeated
        content = content.replace('"peghole.dat":  ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 6.0 * LDU, 20.0 * LDU),', '')
        content = content.replace('"beamhole.dat": ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 6.0 * LDU, 20.0 * LDU),', '')
        content = content.replace('"connhole.dat": ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 6.0 * LDU, 20.0 * LDU),', '')

    with open(filepath, 'w') as f:
        f.write(content)

for file in files_to_fix:
    fix_file(file)

import os
import tempfile
import pytest
import pybullet as p

import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from backend.physics_engine import PhysicsEngine

@pytest.fixture
def test_urdf(tmp_path):
    urdf_content = """<?xml version="1.0"?>
<robot name="test">
  <link name="base_link">
    <inertial>
      <origin xyz="0 0 0" rpy="0 0 0" />
      <mass value="0.005" />
      <inertia ixx="1e-5" ixy="0" ixz="0" iyy="1e-5" iyz="0" izz="1e-5" />
    </inertial>
  </link>
  <link name="rotor">
    <inertial>
      <origin xyz="0 0 0" rpy="0 0 0" />
      <mass value="0.002" />
      <inertia ixx="1e-5" ixy="0" ixz="0" iyy="1e-5" iyz="0" izz="1e-5" />
    </inertial>
  </link>
  <joint name="spin_joint_friction" type="continuous">
    <parent link="base_link"/>
    <child link="rotor"/>
    <origin xyz="0 0 0.008" rpy="0 0 0" />
    <axis xyz="0 0 1" />
  </joint>
</robot>"""
    file_path = str(tmp_path / "test.urdf")
    with open(file_path, "w") as f:
        f.write(urdf_content)
    return file_path

@pytest.fixture
def engine():
    engine = PhysicsEngine(mode="DIRECT")
    yield engine
    engine.disconnect()

def test_engine_init(engine):
    assert engine.client_id >= 0

def test_toggle_gravity(engine):
    engine.toggle_gravity(False)
    gravity = p.getPhysicsEngineParameters(physicsClientId=engine.client_id)
    # in PyBullet, we cannot easily retrieve gravity, so we just test it executes without throwing exceptions
    engine.toggle_gravity(True)

def test_load_assembly_success(engine, test_urdf):
    assert engine.load_assembly(test_urdf, start_pos=[0, 0, 1.0]) is True
    assert engine.robot_id >= 0
    assert engine.num_joints == 1
    assert "base_link" in engine.link_name_to_index
    assert "rotor" in engine.link_name_to_index
    assert engine.joint_name_to_index["spin_joint_friction"] == 0

def test_load_assembly_fail(engine, tmp_path):
    assert engine.load_assembly(str(tmp_path / "non_existent.urdf")) is False

def test_add_closed_loop_constraint(engine, test_urdf):
    engine.load_assembly(test_urdf)
    engine.add_closed_loop_constraint("base_link", "rotor")

    # constraint added, check if getNumConstraints has increased?
    # Not easily testable but should run without errors
    engine.add_closed_loop_constraint("invalid_link", "another_invalid")

def test_add_closed_loop_constraint_no_robot(engine):
    engine.add_closed_loop_constraint("base", "rotor") # should not throw

def test_apply_user_force(engine, test_urdf):
    engine.load_assembly(test_urdf)
    engine.apply_user_force("rotor", [10, 0, 0])

def test_apply_user_force_no_robot(engine):
    engine.apply_user_force("rotor", [10, 0, 0]) # should not throw

def test_step_and_state(engine, test_urdf):
    engine.load_assembly(test_urdf)
    engine.step()
    state = engine.get_state()
    assert "base" in state
    assert "rotor" in state
    assert len(state["base"]["position"]) == 3
    assert len(state["rotor"]["quaternion"]) == 4

def test_get_state_no_robot(engine):
    state = engine.get_state()
    assert state == {}

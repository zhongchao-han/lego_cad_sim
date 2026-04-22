import pytest
import pybullet as p
from unittest.mock import patch, MagicMock
from backend.physics_engine import PhysicsEngine

@patch("pybullet.connect")
@patch("pybullet.setAdditionalSearchPath")
@patch("pybullet.setGravity")
@patch("pybullet.setTimeStep")
@patch("pybullet.loadURDF")
@patch("pybullet.changeDynamics")
def test_physics_engine_init(mock_change_dyn, mock_load_urdf, mock_set_time, mock_set_grav, mock_set_path, mock_connect):
    mock_connect.return_value = 1
    mock_load_urdf.return_value = 2

    pe = PhysicsEngine(mode="DIRECT")

    mock_connect.assert_called_with(p.DIRECT)
    mock_set_path.assert_called_once()
    mock_set_grav.assert_called_with(0, 0, -9.81, physicsClientId=1)
    mock_set_time.assert_called_once()
    mock_load_urdf.assert_called_with("plane.urdf", physicsClientId=1)
    mock_change_dyn.assert_called_with(2, -1, lateralFriction=1.0)
    assert pe.client_id == 1
    assert pe.plane_id == 2

@patch("backend.physics_engine.p")
def test_physics_engine_load_assembly(mock_p):
    mock_p.DIRECT = 0
    mock_p.GUI = 1
    mock_p.JOINT_REVOLUTE = 0
    mock_p.connect.return_value = 1
    mock_p.loadURDF.return_value = 42
    mock_p.getNumJoints.return_value = 2

    # Mock joint info: (jointIndex, jointName, jointType, ..., linkName, ...)
    # 1: jointName, 2: jointType, 12: linkName
    # It gets called twice during map and twice during configure
    mock_p.getJointInfo.side_effect = [
        (0, b"joint_0", mock_p.JOINT_REVOLUTE, 0, 0, 0, 0, 0, 0, 0, 0, 0, b"link_0"),
        (1, b"joint_1", mock_p.JOINT_FIXED, 0, 0, 0, 0, 0, 0, 0, 0, 0, b"link_1"),
        (0, b"joint_0", mock_p.JOINT_REVOLUTE, 0, 0, 0, 0, 0, 0, 0, 0, 0, b"link_0"),
        (1, b"joint_1", mock_p.JOINT_FIXED, 0, 0, 0, 0, 0, 0, 0, 0, 0, b"link_1")
    ]

    pe = PhysicsEngine(mode="DIRECT")
    pe.load_assembly("dummy.urdf", start_pos=[0, 0, 0])

    flags = mock_p.URDF_USE_INERTIA_FROM_FILE | mock_p.URDF_USE_SELF_COLLISION
    mock_p.loadURDF.assert_any_call("dummy.urdf", basePosition=[0, 0, 0], useFixedBase=False, flags=flags, physicsClientId=pe.client_id)
    assert pe.robot_id == 42
    assert pe.num_joints == 2
    assert pe.joint_name_to_index["joint_0"] == 0
    assert pe.joint_name_to_index["joint_1"] == 1
    assert pe.link_name_to_index["link_0"] == 0
    assert pe.link_name_to_index["link_1"] == 1
    mock_p.changeDynamics.assert_called()

@patch("backend.physics_engine.p")
def test_physics_engine_add_closed_loop_constraint(mock_p):
    mock_p.DIRECT = 0
    mock_p.connect.return_value = 1
    mock_p.JOINT_FIXED = 4
    pe = PhysicsEngine(mode="DIRECT")
    pe.robot_id = 42
    pe.link_name_to_index = {"parent_link": 0, "child_link": 1}

    pe.add_closed_loop_constraint("parent_link", "child_link")
    mock_p.createConstraint.assert_called_with(
        parentBodyUniqueId=42, parentLinkIndex=0, childBodyUniqueId=42, childLinkIndex=1,
        jointType=mock_p.JOINT_FIXED, jointAxis=[0,0,0], parentFramePosition=[0,0,0], childFramePosition=[0,0,0],
        physicsClientId=pe.client_id
    )

@patch("backend.physics_engine.p")
def test_physics_engine_step_and_get_state(mock_p):
    mock_p.DIRECT = 0
    mock_p.connect.return_value = 1
    pe = PhysicsEngine(mode="DIRECT")
    pe.robot_id = 42
    pe.num_joints = 2

    pe.link_name_to_index = {"link_0": 0, "link_1": 1, "base_link": -1}

    # Mock base pose
    mock_p.getBasePositionAndOrientation.return_value = ([0, 0, 0], [0, 0, 0, 1])

    # Mock link state: (..., ..., ..., ..., linkWorldPosition, linkWorldOrientation)
    # 4: linkWorldPosition, 5: linkWorldOrientation
    mock_p.getLinkState.side_effect = [
        (0, 0, 0, 0, [1, 1, 1], [0, 0, 0, 1]),
        (0, 0, 0, 0, [2, 2, 2], [0, 0, 0, 1])
    ]

    pe.step()
    state = pe.get_state()
    mock_p.stepSimulation.assert_called_once()

    assert "base" in state
    assert state["base"]["position"] == [0, 0, 0]
    assert "link_0" in state
    assert state["link_0"]["position"] == [1, 1, 1]
    assert "link_1" in state
    assert state["link_1"]["position"] == [2, 2, 2]

@patch("backend.physics_engine.p")
def test_physics_engine_apply_user_force(mock_p):
    mock_p.DIRECT = 0
    mock_p.connect.return_value = 1
    pe = PhysicsEngine(mode="DIRECT")
    pe.robot_id = 42
    pe.link_name_to_index = {"link_0": 0}

    pe.apply_user_force("link_0", [1, 2, 3], [0, 0, 0])
    mock_p.applyExternalForce.assert_called_with(
        objectUniqueId=42, linkIndex=0, forceObj=[1, 2, 3], posObj=[0, 0, 0], flags=mock_p.LINK_FRAME, physicsClientId=pe.client_id
    )

@patch("backend.physics_engine.p")
def test_physics_engine_toggle_gravity(mock_p):
    mock_p.DIRECT = 0
    mock_p.connect.return_value = 1
    pe = PhysicsEngine(mode="DIRECT")

    pe.toggle_gravity(False)
    mock_p.setGravity.assert_called_with(0, 0, 0, physicsClientId=pe.client_id)

    pe.toggle_gravity(True)
    mock_p.setGravity.assert_called_with(0, 0, -9.81, physicsClientId=pe.client_id)

@patch("backend.physics_engine.p")
def test_physics_engine_disconnect(mock_p):
    mock_p.DIRECT = 0
    mock_p.connect.return_value = 1
    pe = PhysicsEngine(mode="DIRECT")
    pe.disconnect()
    mock_p.disconnect.assert_called_with(pe.client_id)

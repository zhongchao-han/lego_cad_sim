import pytest
from unittest.mock import MagicMock, patch
from backend.physics_engine import PhysicsEngine

class TestPhysicsEngine:

    @patch('backend.physics_engine.p')
    def test_init_and_setup(self, mock_p):
        mock_p.connect.return_value = 1
        mock_p.loadURDF.return_value = 100

        engine = PhysicsEngine(mode="DIRECT")

        mock_p.connect.assert_called_with(mock_p.DIRECT)
        mock_p.setGravity.assert_called_with(0, 0, -9.81, physicsClientId=1)
        mock_p.loadURDF.assert_called_with("plane.urdf", physicsClientId=1)
        assert engine.plane_id == 100

    @patch('backend.physics_engine.p')
    def test_toggle_gravity(self, mock_p):
        mock_p.connect.return_value = 1
        engine = PhysicsEngine(mode="DIRECT")

        engine.toggle_gravity(False)
        mock_p.setGravity.assert_called_with(0, 0, 0, physicsClientId=1)

        engine.toggle_gravity(True)
        mock_p.setGravity.assert_called_with(0, 0, -9.81, physicsClientId=1)

    @patch('backend.physics_engine.p')
    def test_load_assembly(self, mock_p):
        mock_p.connect.return_value = 1
        mock_p.loadURDF.side_effect = [100, 200] # plane_id, robot_id
        mock_p.getNumJoints.return_value = 1

        # mock joint info (joint_name, joint_type, ..., link_name)
        mock_p.getJointInfo.return_value = (0, b"spin_joint", mock_p.JOINT_CONTINUOUS, 0, 0, 0, 0, 0, 0, 0, 0, 0, b"rotor_link")

        engine = PhysicsEngine(mode="DIRECT")
        success = engine.load_assembly("dummy.urdf")

        assert success is True
        assert engine.robot_id == 200
        assert engine.num_joints == 1
        assert "spin_joint" in engine.joint_name_to_index
        assert "rotor_link" in engine.link_name_to_index
        assert engine.link_name_to_index["base_link"] == -1

        # verify joint config
        mock_p.setJointMotorControl2.assert_any_call(bodyIndex=200, jointIndex=0, controlMode=mock_p.VELOCITY_CONTROL, targetVelocity=0, force=0.05, physicsClientId=1)

    @patch('backend.physics_engine.p')
    def test_add_closed_loop_constraint(self, mock_p):
        mock_p.connect.return_value = 1
        engine = PhysicsEngine(mode="DIRECT")
        engine.robot_id = 200
        engine.link_name_to_index = {"link_A": 1, "link_B": 2}

        engine.add_closed_loop_constraint("link_A", "link_B")
        mock_p.createConstraint.assert_called_with(
            parentBodyUniqueId=200, parentLinkIndex=1, childBodyUniqueId=200, childLinkIndex=2,
            jointType=mock_p.JOINT_FIXED, jointAxis=[0,0,0], parentFramePosition=[0,0,0], childFramePosition=[0,0,0], physicsClientId=1
        )

    @patch('backend.physics_engine.p')
    def test_apply_user_force_and_step(self, mock_p):
        mock_p.connect.return_value = 1
        engine = PhysicsEngine(mode="DIRECT")
        engine.robot_id = 200
        engine.link_name_to_index = {"link_A": 1}

        engine.apply_user_force("link_A", [0, 10, 0], [0, 0, 0])
        mock_p.applyExternalForce.assert_called_with(
            objectUniqueId=200, linkIndex=1, forceObj=[0, 10, 0], posObj=[0, 0, 0], flags=mock_p.LINK_FRAME, physicsClientId=1
        )

        engine.step()
        mock_p.stepSimulation.assert_called_with(physicsClientId=1)

    @patch('backend.physics_engine.p')
    def test_get_state_and_disconnect(self, mock_p):
        mock_p.connect.return_value = 1
        engine = PhysicsEngine(mode="DIRECT")
        engine.robot_id = 200
        engine.link_name_to_index = {"base_link": -1, "link_A": 0}

        mock_p.getBasePositionAndOrientation.return_value = ([0,0,0], [0,0,0,1])
        # getLinkState returns tuple, index 4 and 5 are position and orientation
        mock_p.getLinkState.return_value = (0, 0, 0, 0, [1,1,1], [0,1,0,0])

        state = engine.get_state()
        assert "base" in state
        assert state["base"]["position"] == [0,0,0]
        assert "link_A" in state
        assert state["link_A"]["position"] == [1,1,1]

        engine.disconnect()
        mock_p.disconnect.assert_called_with(1)

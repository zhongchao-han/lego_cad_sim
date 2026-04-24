import pytest
from unittest.mock import patch, MagicMock
from backend.physics_engine import PhysicsEngine

class TestPhysicsEngine:
    @patch("backend.physics_engine.p")
    @patch("backend.physics_engine.pybullet_data")
    def test_init_and_setup(self, mock_pybullet_data, mock_p):
        mock_p.GUI = 1
        mock_p.DIRECT = 2
        mock_p.connect.return_value = 100
        mock_p.loadURDF.return_value = 101

        engine = PhysicsEngine(mode="DIRECT")

        mock_p.connect.assert_called_with(2)
        mock_p.setGravity.assert_called_with(0, 0, -9.81, physicsClientId=100)
        mock_p.setTimeStep.assert_called()
        mock_p.loadURDF.assert_called_with("plane.urdf", physicsClientId=100)

    @patch("backend.physics_engine.p")
    @patch("backend.physics_engine.pybullet_data")
    def test_toggle_gravity(self, mock_pybullet_data, mock_p):
        engine = PhysicsEngine(mode="DIRECT")

        engine.toggle_gravity(True)
        mock_p.setGravity.assert_called_with(0, 0, -9.81, physicsClientId=engine.client_id)

        engine.toggle_gravity(False)
        mock_p.setGravity.assert_called_with(0, 0, 0, physicsClientId=engine.client_id)

    @patch("backend.physics_engine.p")
    @patch("backend.physics_engine.pybullet_data")
    def test_load_assembly(self, mock_pybullet_data, mock_p):
        engine = PhysicsEngine(mode="DIRECT")

        mock_p.loadURDF.return_value = 200
        mock_p.getNumJoints.return_value = 1

        # mock joint info (for name mapping and joint config)
        # jointIndex=0, jointName=b'test_joint', jointType=JOINT_REVOLUTE(0), linkName=b'test_link'
        mock_p.JOINT_CONTINUOUS = 4
        mock_p.JOINT_REVOLUTE = 0
        mock_p.getJointInfo.return_value = (0, b'test_joint', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, b'test_link')

        res = engine.load_assembly("dummy.urdf", [0, 0, 0])
        assert res is True
        assert engine.robot_id == 200
        assert engine.num_joints == 1
        assert engine.joint_name_to_index["test_joint"] == 0
        assert engine.link_name_to_index["test_link"] == 0

        # test ccd
        mock_p.changeDynamics.assert_any_call(200, -1, ccdSweptSphereRadius=0.001, physicsClientId=engine.client_id)

    @patch("backend.physics_engine.p")
    @patch("backend.physics_engine.pybullet_data")
    def test_add_closed_loop_constraint(self, mock_pybullet_data, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.robot_id = 200
        engine.link_name_to_index = {"parent": 1, "child": 2}

        mock_p.JOINT_FIXED = 4
        mock_p.createConstraint.return_value = 99

        engine.add_closed_loop_constraint("parent", "child")

        mock_p.createConstraint.assert_called_with(
            parentBodyUniqueId=200,
            parentLinkIndex=1,
            childBodyUniqueId=200,
            childLinkIndex=2,
            jointType=4,
            jointAxis=[0,0,0],
            parentFramePosition=[0,0,0],
            childFramePosition=[0,0,0],
            physicsClientId=engine.client_id
        )

    @patch("backend.physics_engine.p")
    @patch("backend.physics_engine.pybullet_data")
    def test_apply_user_force(self, mock_pybullet_data, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.robot_id = 200
        engine.link_name_to_index = {"test_link": 1}

        mock_p.LINK_FRAME = 2
        engine.apply_user_force("test_link", [10, 0, 0], [0, 0, 0])

        mock_p.applyExternalForce.assert_called_with(
            objectUniqueId=200,
            linkIndex=1,
            forceObj=[10, 0, 0],
            posObj=[0, 0, 0],
            flags=2,
            physicsClientId=engine.client_id
        )

    @patch("backend.physics_engine.p")
    @patch("backend.physics_engine.pybullet_data")
    def test_get_state(self, mock_pybullet_data, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.robot_id = 200
        engine.link_name_to_index = {"base_link": -1, "test_link": 0}

        mock_p.getBasePositionAndOrientation.return_value = ([0,0,0], [0,0,0,1])
        # getLinkState returns a tuple, idx 4 is pos, idx 5 is quat
        mock_p.getLinkState.return_value = (0, 0, 0, 0, [1,1,1], [1,0,0,0])

        state = engine.get_state()

        assert "base" in state
        assert state["base"]["position"] == [0,0,0]

        assert "test_link" in state
        assert state["test_link"]["position"] == [1,1,1]

    @patch("backend.physics_engine.p")
    @patch("backend.physics_engine.pybullet_data")
    def test_step_and_disconnect(self, mock_pybullet_data, mock_p):
        engine = PhysicsEngine(mode="DIRECT")

        engine.step()
        mock_p.stepSimulation.assert_called_with(physicsClientId=engine.client_id)

        engine.disconnect()
        mock_p.disconnect.assert_called_with(engine.client_id)

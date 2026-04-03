import unittest
from unittest.mock import patch

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.physics_engine import PhysicsEngine

class TestPhysicsEngine(unittest.TestCase):
    @patch('backend.physics_engine.p')
    def test_init_and_setup(self, mock_p):
        mock_p.connect.return_value = 1
        mock_p.loadURDF.return_value = 100

        engine = PhysicsEngine(mode="DIRECT")

        mock_p.connect.assert_called_with(mock_p.DIRECT)
        mock_p.setAdditionalSearchPath.assert_called()
        mock_p.setGravity.assert_called_with(0, 0, -9.81, physicsClientId=1)
        mock_p.setTimeStep.assert_called()
        mock_p.loadURDF.assert_called_with("plane.urdf", physicsClientId=1)
        mock_p.changeDynamics.assert_called_with(100, -1, lateralFriction=1.0)

        self.assertEqual(engine.client_id, 1)

    @patch('backend.physics_engine.p')
    def test_toggle_gravity(self, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.client_id = 1

        engine.toggle_gravity(True)
        mock_p.setGravity.assert_called_with(0, 0, -9.81, physicsClientId=1)

        engine.toggle_gravity(False)
        mock_p.setGravity.assert_called_with(0, 0, 0, physicsClientId=1)

    @patch('backend.physics_engine.p')
    def test_load_assembly(self, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.client_id = 1
        mock_p.loadURDF.return_value = 200
        mock_p.getNumJoints.return_value = 2

        # Need to provide error exception type for the try except block
        mock_p.error = Exception

        # mock joint info
        # getJointInfo is called twice inside _map_link_and_joint_names and twice inside _configure_joints
        # getJointInfo returns tuple, index 1 is joint_name, 2 is joint_type, 12 is link_name
        mock_info = [
            (0, b"friction_joint", mock_p.JOINT_CONTINUOUS, 0, 0, 0, 0, 0, 0, 0, 0, 0, b"link_1"),
            (1, b"loose_joint", mock_p.JOINT_REVOLUTE, 0, 0, 0, 0, 0, 0, 0, 0, 0, b"link_2"),
        ]
        mock_p.getJointInfo.side_effect = mock_info * 2

        result = engine.load_assembly("test.urdf")
        self.assertTrue(result)
        self.assertEqual(engine.robot_id, 200)

        # Check mapping
        self.assertIn("friction_joint", engine.joint_name_to_index)
        self.assertIn("link_1", engine.link_name_to_index)
        self.assertEqual(engine.link_name_to_index["base_link"], -1)

        # Check clutch power applied correctly based on "friction" in name
        mock_p.setJointMotorControl2.assert_any_call(
            bodyIndex=200, jointIndex=0, controlMode=mock_p.VELOCITY_CONTROL,
            targetVelocity=0, force=1.5, physicsClientId=1
        )
        mock_p.setJointMotorControl2.assert_any_call(
            bodyIndex=200, jointIndex=1, controlMode=mock_p.VELOCITY_CONTROL,
            targetVelocity=0, force=0.05, physicsClientId=1
        )

    @patch('backend.physics_engine.p')
    def test_add_closed_loop_constraint(self, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.client_id = 1
        engine.robot_id = 200
        engine.link_name_to_index = {"link_a": 3, "link_b": 4}

        mock_p.createConstraint.return_value = 50
        engine.add_closed_loop_constraint("link_a", "link_b")

        mock_p.createConstraint.assert_called_once_with(
            parentBodyUniqueId=200, parentLinkIndex=3,
            childBodyUniqueId=200, childLinkIndex=4,
            jointType=mock_p.JOINT_FIXED, jointAxis=[0,0,0],
            parentFramePosition=[0,0,0], childFramePosition=[0,0,0],
            physicsClientId=1
        )

    @patch('backend.physics_engine.p')
    def test_apply_user_force(self, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.client_id = 1
        engine.robot_id = 200
        engine.link_name_to_index = {"link_a": 3}

        engine.apply_user_force("link_a", [10, 0, 0])

        mock_p.applyExternalForce.assert_called_once_with(
            objectUniqueId=200, linkIndex=3,
            forceObj=[10, 0, 0], posObj=[0,0,0],
            flags=mock_p.LINK_FRAME, physicsClientId=1
        )

    @patch('backend.physics_engine.p')
    def test_get_state(self, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.client_id = 1
        engine.robot_id = 200
        engine.link_name_to_index = {"base_link": -1, "link_a": 3}

        mock_p.getBasePositionAndOrientation.return_value = ([0,0,0], [0,0,0,1])
        # Returns tuple where index 4 is pos, 5 is quat
        mock_p.getLinkState.return_value = (0, 0, 0, 0, [1,1,1], [0,1,0,0])

        state = engine.get_state()

        self.assertIn("base", state)
        self.assertEqual(state["base"]["position"], [0,0,0])
        self.assertIn("link_a", state)
        self.assertEqual(state["link_a"]["position"], [1,1,1])

    @patch('backend.physics_engine.p')
    def test_step_and_disconnect(self, mock_p):
        engine = PhysicsEngine(mode="DIRECT")
        engine.client_id = 1

        engine.step()
        mock_p.stepSimulation.assert_called_once_with(physicsClientId=1)

        engine.disconnect()
        mock_p.disconnect.assert_called_once_with(1)

if __name__ == "__main__":
    unittest.main()

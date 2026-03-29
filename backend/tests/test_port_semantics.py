import unittest
import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.port_semantics import (
    get_interface, check_fit, derive_joint_params, build_fit_result,
    ConnectionInterface, Gender, Profile, FitType
)

class TestPortSemantics(unittest.TestCase):
    def test_get_interface_exact(self):
        interface = get_interface("peghole")
        self.assertIsNotNone(interface)
        self.assertEqual(interface.gender, Gender.FEMALE)

    def test_get_interface_fuzzy(self):
        interface = get_interface("peghole2.dat")
        self.assertIsNotNone(interface)
        self.assertEqual(interface.gender, Gender.FEMALE)

    def test_check_fit_valid_clearance(self):
        plug = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 0.002, 0.01)
        socket = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 0.003, 0.01)
        self.assertEqual(check_fit(plug, socket), FitType.CLEARANCE)

    def test_check_fit_valid_friction(self):
        plug = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 0.0024, 0.01)
        socket = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 0.0023, 0.01)
        self.assertEqual(check_fit(plug, socket), FitType.FRICTION)

    def test_check_fit_blocked(self):
        plug = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 0.003, 0.01)
        socket = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 0.002, 0.01)
        self.assertEqual(check_fit(plug, socket), FitType.BLOCKED)

    def test_check_fit_incompatible(self):
        plug = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 0.002, 0.01)
        socket = ConnectionInterface(Gender.FEMALE, Profile.CROSS, 0.002, 0.01)
        self.assertEqual(check_fit(plug, socket), FitType.INCOMPATIBLE)

    def test_derive_joint_params(self):
        plug = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 0.0024, 0.01)
        socket = ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 0.0023, 0.01)

        j_type, damping, friction = derive_joint_params(plug, socket, False)
        self.assertIn(j_type, ["revolute", "continuous", "fixed", "prismatic"])

    def test_build_fit_result(self):
        res = build_fit_result(
            ConnectionInterface(Gender.MALE, Profile.CYLINDER, 0.002, 0.01),
            ConnectionInterface(Gender.FEMALE, Profile.CYLINDER, 0.003, 0.01),
            "peg_id", "hole_id"
        )
        self.assertIn("peg_id", res)
        self.assertTrue(res["can_fully_insert"])
        self.assertEqual(res["fit_type"], FitType.CLEARANCE.value)

if __name__ == '__main__':
    unittest.main()

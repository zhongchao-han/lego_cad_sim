import unittest
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.port_semantics import (
    get_interface,
    check_fit,
    derive_joint_params,
    build_fit_result,
    ConnectionInterface,
    Gender,
    Profile,
    FitType
)
from backend.core_constants import LDU

class TestPortSemantics(unittest.TestCase):
    def test_get_interface_exact_match(self):
        iface = get_interface("peghole")
        self.assertIsNotNone(iface)
        self.assertEqual(iface.gender, Gender.FEMALE)
        self.assertEqual(iface.profile, Profile.CYLINDER)

    def test_get_interface_suffix_match(self):
        iface = get_interface("peghole.dat")
        self.assertIsNotNone(iface)
        self.assertEqual(iface.gender, Gender.FEMALE)

    def test_get_interface_fuzzy_match(self):
        # Should match 'stud' prefix
        iface = get_interface("stud5a.dat")
        self.assertIsNotNone(iface)
        self.assertEqual(iface.profile, Profile.STUD)

    def test_get_interface_not_found(self):
        iface = get_interface("completely_unknown_part.dat")
        self.assertIsNone(iface)

    def test_check_fit_incompatible(self):
        pin = get_interface("pin.dat")
        axle = get_interface("axle.dat")
        hole = get_interface("peghole.dat")
        axlehole = get_interface("axlehole.dat")

        # MALE + MALE
        self.assertEqual(check_fit(pin, axle), FitType.INCOMPATIBLE)
        # FEMALE + FEMALE
        self.assertEqual(check_fit(hole, axlehole), FitType.INCOMPATIBLE)
        # CYLINDER + CROSS
        self.assertEqual(check_fit(pin, axlehole), FitType.INCOMPATIBLE)

    def test_check_fit_clearance(self):
        pin = get_interface("pin.dat")
        hole = get_interface("peghole.dat")
        # pin radius 5.9, hole radius 6.0 => delta -0.1 => clearance
        self.assertEqual(check_fit(pin, hole), FitType.CLEARANCE)

    def test_check_fit_friction(self):
        fpin = get_interface("fric_pin.dat")
        hole = get_interface("peghole.dat")
        # fpin radius 6.2, hole radius 6.0 => delta 0.2
        # DELTA_FRICTION_MAX is 0.0003m, 0.2 LDU = 0.00008m <= 0.0003m => friction
        self.assertEqual(check_fit(fpin, hole), FitType.FRICTION)

    def test_check_fit_blocked(self):
        # Create a mock plug that is too big
        big_plug = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 10.0 * LDU, 40.0 * LDU)
        hole = get_interface("peghole.dat")
        # delta = 4.0 LDU = 0.0016m > 0.0003m => blocked
        self.assertEqual(check_fit(big_plug, hole), FitType.BLOCKED)

    def test_derive_joint_params(self):
        pin = get_interface("pin.dat")
        fpin = get_interface("fric_pin.dat")
        hole = get_interface("peghole.dat")
        axle = get_interface("axle.dat")
        axlehole = get_interface("axlehole.dat")
        stud = get_interface("stud.dat")
        tube = get_interface("tube.dat")

        # Overconstrained
        j_type, d, f = derive_joint_params(pin, hole, is_overconstrained=True)
        self.assertEqual(j_type, "fixed")

        # Incompatible
        j_type, d, f = derive_joint_params(pin, axlehole)
        self.assertEqual(j_type, "fixed")

        # Clearance cylinder
        j_type, d, f = derive_joint_params(pin, hole)
        self.assertEqual(j_type, "continuous")
        self.assertEqual(d, 0.05)

        # Friction cylinder
        j_type, d, f = derive_joint_params(fpin, hole)
        self.assertEqual(j_type, "continuous")
        self.assertEqual(d, 1.5)

        # Cross + Cross
        j_type, d, f = derive_joint_params(axle, axlehole)
        self.assertEqual(j_type, "fixed")

        # Stud + Tube
        j_type, d, f = derive_joint_params(stud, tube)
        self.assertEqual(j_type, "fixed")

    def test_build_fit_result(self):
        pin = get_interface("pin.dat")
        hole = get_interface("peghole.dat")

        res = build_fit_result(pin, hole, "peg_1", "hole_1")

        self.assertEqual(res["peg_id"], "peg_1")
        self.assertEqual(res["hole_id"], "hole_1")
        self.assertTrue(res["can_fully_insert"])
        self.assertEqual(res["fit_type"], "clearance")
        self.assertEqual(res["method"], "parametric")

if __name__ == "__main__":
    unittest.main()

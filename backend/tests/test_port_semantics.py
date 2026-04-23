import pytest
from backend.port_semantics import (
    Gender, Profile, FitType, ConnectionInterface,
    get_interface, check_fit, derive_joint_params, build_fit_result
)

class TestPortSemantics:
    def test_get_interface(self):
        # Exact match
        peghole = get_interface("peghole.dat")
        assert peghole.gender == Gender.FEMALE
        assert peghole.profile == Profile.CYLINDER

        # Suffix removal match
        peghole2 = get_interface("peghole")
        assert peghole2.gender == Gender.FEMALE

        # Prefix match
        axlehole2 = get_interface("axlehole2.dat")
        assert axlehole2.profile == Profile.CROSS
        assert axlehole2.gender == Gender.FEMALE

        # Not found
        not_found = get_interface("unknown_random_part.dat")
        assert not_found is None

    def test_check_fit(self):
        pin = get_interface("pin")
        hole = get_interface("peghole")
        fric_pin = get_interface("fric_pin.dat")
        axle = get_interface("axle")
        axlehole = get_interface("axlehole")

        # incompatible gender/profile
        assert check_fit(pin, pin) == FitType.INCOMPATIBLE
        assert check_fit(axle, hole) == FitType.INCOMPATIBLE

        # clearance
        assert check_fit(pin, hole) == FitType.CLEARANCE
        assert check_fit(axle, axlehole) == FitType.CLEARANCE

        # friction
        assert check_fit(fric_pin, hole) == FitType.FRICTION

        # blocked
        too_big_pin = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 10.0, 10.0)
        assert check_fit(too_big_pin, hole) == FitType.BLOCKED

    def test_derive_joint_params(self):
        pin = get_interface("pin")
        hole = get_interface("peghole")
        fric_pin = get_interface("fric_pin.dat")
        axle = get_interface("axle")
        axlehole = get_interface("axlehole")
        stud = get_interface("stud")
        tube = get_interface("tube")

        # overconstrained
        jtype, d, f = derive_joint_params(pin, hole, is_overconstrained=True)
        assert jtype == "fixed"

        # clearance cylinder
        jtype, d, f = derive_joint_params(pin, hole)
        assert jtype == "continuous"
        assert d == 0.05

        # friction cylinder
        jtype, d, f = derive_joint_params(fric_pin, hole)
        assert jtype == "continuous"
        assert d == 1.5

        # cross
        jtype, d, f = derive_joint_params(axle, axlehole)
        assert jtype == "fixed"

        # stud
        jtype, d, f = derive_joint_params(stud, tube)
        assert jtype == "fixed"

        # incompatible
        jtype, d, f = derive_joint_params(axle, hole)
        assert jtype == "fixed"

    def test_build_fit_result(self):
        pin = get_interface("pin")
        hole = get_interface("peghole")

        res = build_fit_result(pin, hole, "peg_1", "hole_1")
        assert res["peg_id"] == "peg_1"
        assert res["hole_id"] == "hole_1"
        assert res["fit_type"] == FitType.CLEARANCE.value
        assert res["can_fully_insert"] is True
        assert res["method"] == "parametric"

        too_big_pin = ConnectionInterface(Gender.MALE, Profile.CYLINDER, 10.0, 10.0)
        res2 = build_fit_result(too_big_pin, hole, "peg_1", "hole_1")
        assert res2["fit_type"] == FitType.BLOCKED.value
        assert res2["can_fully_insert"] is False

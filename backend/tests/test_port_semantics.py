import pytest
from backend.port_semantics import (
    get_interface, check_fit, derive_joint_params, build_fit_result,
    FitType, Gender, Profile
)

class TestPortSemantics:
    def test_get_interface(self):
        # exact match
        iface1 = get_interface("axle.dat")
        assert iface1 is not None
        assert iface1.gender == Gender.MALE
        assert iface1.profile == Profile.CROSS

        # exact without .dat
        iface2 = get_interface("axle")
        assert iface2 is not None

        # prefix match
        iface3 = get_interface("stud10.dat")
        assert iface3 is not None
        assert iface3.profile == Profile.STUD

        # invalid match
        iface4 = get_interface("unknown_part.dat")
        assert iface4 is None

    def test_check_fit(self):
        pin = get_interface("pin.dat")
        hole = get_interface("peghole.dat")
        fric_pin = get_interface("fric_pin.dat")
        axle = get_interface("axle.dat")

        # valid clearance
        assert check_fit(pin, hole) == FitType.CLEARANCE
        # friction fit
        assert check_fit(fric_pin, hole) == FitType.FRICTION
        # incompatible profile
        assert check_fit(axle, hole) == FitType.INCOMPATIBLE
        # incompatible gender (male -> male)
        assert check_fit(pin, pin) == FitType.INCOMPATIBLE

    def test_derive_joint_params(self):
        pin = get_interface("pin.dat")
        hole = get_interface("peghole.dat")
        fric_pin = get_interface("fric_pin.dat")
        axle = get_interface("axle.dat")
        axlehole = get_interface("axlehole.dat")
        stud = get_interface("stud.dat")
        tube = get_interface("tube.dat")

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

    def test_build_fit_result(self):
        pin = get_interface("pin.dat")
        hole = get_interface("peghole.dat")

        res = build_fit_result(pin, hole, "peg", "hole")
        assert res["peg_id"] == "peg"
        assert res["hole_id"] == "hole"
        assert res["fit_type"] == "clearance"
        assert res["method"] == "parametric"
        assert "can_fully_insert" in res

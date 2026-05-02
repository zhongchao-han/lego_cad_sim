"""
backend/tests/conftest.py
=========================
当 ldraw_lib/parts/ 不存在时（典型为 CI 环境），自动跳过依赖真实 LDraw .dat
素材的集成型测试。这些测试在开发机上有 LDraw 库时仍会跑，CI 上则 skip。

未来如果 CI 加上 LDraw 同步步骤（或缓存到 actions cache），此文件即自动失效。
"""
import os
import pytest

_LDRAW_PARTS = os.path.join("ldraw_lib", "parts")
_LDRAW_AVAILABLE = (
    os.path.isdir(_LDRAW_PARTS) and bool(os.listdir(_LDRAW_PARTS))
)

# 通过 nodeid 子串识别依赖 ldraw_lib 的测试。
# 这些测试都通过 GeometryProcessor(ldraw_path="ldraw_lib") 加载具体 .dat 零件，
# 没有 ldraw_lib 时 trimesh.load 会因 GLB 写不出来而抛 ValueError。
_LDRAW_DEPENDENT_TESTS = (
    "test_compute_bounding_box_success",
    "test_axlehol_scaled_ports",
    "test_multi_unit_pin_z_axis_alignment",
    "test_1_3_pitch_sampling_integrity",
    "test_2_1_spatial_sync_glb_json",
)


def pytest_collection_modifyitems(config, items):  # noqa: ARG001 — pytest hook signature
    if _LDRAW_AVAILABLE:
        return
    skip_marker = pytest.mark.skip(
        reason="ldraw_lib/parts/ not populated — skipped under CI baseline"
    )
    for item in items:
        if any(name in item.nodeid for name in _LDRAW_DEPENDENT_TESTS):
            item.add_marker(skip_marker)

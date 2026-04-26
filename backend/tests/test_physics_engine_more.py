import pytest
from backend.physics_engine import PhysicsEngine
from unittest.mock import patch, MagicMock

@patch("backend.physics_engine.p")
def test_physics_engine_setup_world(mock_p):
    pe = PhysicsEngine("DIRECT")
    mock_p.setGravity.assert_called()

@patch("backend.physics_engine.p")
def test_physics_engine_toggle_gravity(mock_p):
    pe = PhysicsEngine("DIRECT")
    pe.toggle_gravity(False)
    mock_p.setGravity.assert_called_with(0, 0, 0, physicsClientId=pe.client_id)
    pe.toggle_gravity(True)
    mock_p.setGravity.assert_called_with(0, 0, -9.81, physicsClientId=pe.client_id)

@patch("backend.physics_engine.p")
def test_physics_engine_load_assembly(mock_p):
    pe = PhysicsEngine("DIRECT")
    mock_p.loadURDF.return_value = 1

    with patch("os.path.exists", return_value=True):
        res = pe.load_assembly("dummy.urdf")
        assert res == True
        assert pe.robot_id == 1

@patch("backend.physics_engine.p")
def test_physics_engine_get_state(mock_p):
    pe = PhysicsEngine("DIRECT")
    pe.robot_id = 1
    pe.link_name_to_index = {"link1": 1}
    mock_p.getBasePositionAndOrientation.return_value = ([0,0,0], [0,0,0,1])
    mock_p.getLinkState.return_value = ([0,0,0], [0,0,0,1], [0,0,0], [0,0,0], [0,0,0], [0,0,0])

    state = pe.get_state()
    assert "base" in state
    assert "link1" in state

@patch("backend.physics_engine.p")
def test_physics_engine_disconnect(mock_p):
    pe = PhysicsEngine("DIRECT")
    pe.disconnect()
    mock_p.disconnect.assert_called()

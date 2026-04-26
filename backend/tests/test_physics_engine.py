import pytest
from backend.physics_engine import PhysicsEngine
from unittest.mock import patch, MagicMock

@patch("backend.physics_engine.p")
def test_physics_engine_init(mock_p):
    pe = PhysicsEngine()
    mock_p.connect.assert_called()

@patch("backend.physics_engine.p")
def test_physics_engine_step(mock_p):
    pe = PhysicsEngine()
    pe.step()
    mock_p.stepSimulation.assert_called()

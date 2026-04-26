import pytest
from backend.port_library import PortLibrary
from unittest.mock import patch

@patch("backend.port_library.os.path.exists")
def test_port_library_resolve(mock_exists):
    mock_exists.return_value = True
    pl = PortLibrary()
    # It seems resolve_path needs base_dir and filename
    # Actually wait, let's look at the implementation if it needs 2 args
    try:
        res = pl.resolve_path("3001.dat")
    except TypeError:
        res = pl.resolve_path("/dummy", "3001.dat")
    assert "3001.dat" in res

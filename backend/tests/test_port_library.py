import os
from unittest.mock import mock_open, patch
import numpy as np
from backend.port_library import PortLibrary

class TestPortLibrary:
    def test_init_with_datastore(self):
        store = {"123.dat": {"ports": []}}
        lib = PortLibrary(data_store=store)
        assert lib._data == store

    @patch('os.path.exists')
    @patch('builtins.open', new_callable=mock_open, read_data='{"123.dat": {"status": "verified"}}')
    def test_init_without_datastore(self, mock_file, mock_exists):
        mock_exists.return_value = True
        lib = PortLibrary()
        assert "123.dat" in lib._data
        assert lib._data["123.dat"]["status"] == "verified"

    def test_resolve_path(self, tmp_path):
        root = str(tmp_path)
        os.makedirs(os.path.join(root, "parts", "s"))
        file_path = os.path.join(root, "parts", "s", "123s01.dat")
        with open(file_path, "w") as f:
            f.write("data")

        # exact resolution through search_roots -> parts/s/
        res = PortLibrary.resolve_path(root, "123s01.dat")
        assert res == file_path

        # fallback path
        fallback_path = os.path.join(root, "p", "456.dat")
        os.makedirs(os.path.join(root, "p"))
        with open(fallback_path, "w") as f:
            f.write("data")
        res2 = PortLibrary.resolve_path(root, "p/456.dat")
        assert res2 == fallback_path

        # not found
        assert PortLibrary.resolve_path(root, "nonexistent.dat") is None

    def test_parse_dat_file(self):
        mock_data = {
            "verified_flat.dat": {
                "status": "verified",
                "ports": [
                    {"type": "pin", "position": [1, 2, 3], "rotation": [[1,0,0],[0,1,0],[0,0,1]]}
                ]
            },
            "verified_site.dat": {
                "status": "verified",
                "sites": [
                    {
                        "position": [10, 0, 0],
                        "ports": [
                            {"type": "axlehole"} # no local pos, should use site pos
                        ]
                    }
                ]
            },
            "pending.dat": {
                "status": "pending",
                "ports": []
            }
        }

        lib = PortLibrary(data_store=mock_data)

        # 1. Parse flat verified
        ports = lib.parse_dat_file("verified_flat.dat")
        assert len(ports) == 1
        assert ports[0].port_type == "pin"
        assert np.allclose(ports[0].position, [1, 2, 3])

        # 2. Parse site verified
        ports2 = lib.parse_dat_file("verified_site.dat")
        assert len(ports2) == 1
        assert ports2[0].port_type == "axlehole"
        assert np.allclose(ports2[0].position, [10, 0, 0])

        # 3. Parse pending (strict mode)
        ports3 = lib.parse_dat_file("pending.dat")
        assert len(ports3) == 0

        # 4. Parse pending (allow_pending)
        ports4 = lib.parse_dat_file("pending.dat", allow_pending=True)
        assert len(ports4) == 0 # no ports defined anyway, but it passes the filter

        # 5. Not found
        ports5 = lib.parse_dat_file("unknown.dat")
        assert len(ports5) == 0

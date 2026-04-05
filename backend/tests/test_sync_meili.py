import os
import json
import tempfile
import pytest
from unittest.mock import patch, MagicMock

import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
import backend.sync_meili as sm

def test_get_part_name_file_not_exist():
    with patch("backend.sync_meili.os.path.exists", return_value=False):
        assert sm.get_part_name("123.dat") == "123.dat"

def test_get_part_name_file_exist(tmp_path):
    part_path = str(tmp_path / "123.dat")
    with open(part_path, "w") as f:
        f.write("0 My Custom Part\n1 16 0 0 0")

    with patch("backend.sync_meili.LDRAW_PARTS_DIR", str(tmp_path)):
        assert sm.get_part_name("123.dat") == "My Custom Part"

def test_get_part_name_wrong_format(tmp_path):
    part_path = str(tmp_path / "123.dat")
    with open(part_path, "w") as f:
        f.write("1 16 0 0 0")

    with patch("backend.sync_meili.LDRAW_PARTS_DIR", str(tmp_path)):
        assert sm.get_part_name("123.dat") == "123.dat"

def test_get_part_name_exception():
    with patch("backend.sync_meili.os.path.exists", return_value=True):
        with patch("builtins.open", side_effect=Exception("Read error")):
            assert sm.get_part_name("123.dat") == "123.dat"

def test_sync_no_data_file():
    with patch("backend.sync_meili.os.path.exists", return_value=False):
        sm.sync_to_meilisearch()  # Should return silently and just log

def test_sync_json_load_error(tmp_path):
    data_file = str(tmp_path / "data.json")
    with open(data_file, "w") as f:
        f.write("invalid json")

    with patch("backend.sync_meili.DATA_FILE", data_file):
        sm.sync_to_meilisearch() # Should return silently and just log

def test_sync_success(tmp_path):
    data_file = str(tmp_path / "data.json")
    with open(data_file, "w") as f:
        json.dump({"3001.dat": {"status": "verified"}}, f)

    part_path = str(tmp_path / "3001.dat")
    with open(part_path, "w") as f:
        f.write("0 Brick 2 x 4\n")

    mock_client = MagicMock()
    mock_index = MagicMock()
    mock_client.index.return_value = mock_index

    with patch("backend.sync_meili.DATA_FILE", data_file):
        with patch("backend.sync_meili.LDRAW_PARTS_DIR", str(tmp_path)):
            with patch("backend.sync_meili.meilisearch.Client", return_value=mock_client):
                sm.sync_to_meilisearch()

                mock_client.index.assert_any_call("parts")
                mock_index.update_settings.assert_called_once()
                mock_index.add_documents.assert_called_once()
                args, kwargs = mock_index.add_documents.call_args
                docs = args[0]
                assert len(docs) == 1
                assert docs[0]["id"] == "3001"
                assert docs[0]["name"] == "Brick 2 x 4"

def test_sync_empty_docs(tmp_path):
    data_file = str(tmp_path / "data.json")
    with open(data_file, "w") as f:
        json.dump({}, f)

    mock_client = MagicMock()

    with patch("backend.sync_meili.DATA_FILE", data_file):
        with patch("backend.sync_meili.meilisearch.Client", return_value=mock_client):
            sm.sync_to_meilisearch()

            mock_client.index.assert_called_once()
            # empty docs shouldn't call add_documents
            mock_client.index.return_value.add_documents.assert_not_called()

def test_sync_exception(tmp_path):
    data_file = str(tmp_path / "data.json")
    with open(data_file, "w") as f:
        json.dump({"3001.dat": {}}, f)

    with patch("backend.sync_meili.DATA_FILE", data_file):
        with patch("backend.sync_meili.meilisearch.Client", side_effect=Exception("Meili Error")):
            sm.sync_to_meilisearch() # Should return silently and just log

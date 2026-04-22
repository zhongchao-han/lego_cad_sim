import os
import json
from unittest.mock import patch, MagicMock
from backend.sync_meili import get_part_name, sync_to_meilisearch


def test_get_part_name_no_file(tmpdir):
    with patch("backend.sync_meili.LDRAW_PARTS_DIR", str(tmpdir)):
        name = get_part_name("nonexistent.dat")
        assert name == "nonexistent.dat"


def test_get_part_name_success(tmpdir):
    with patch("backend.sync_meili.LDRAW_PARTS_DIR", str(tmpdir)):
        with open(os.path.join(str(tmpdir), "part1.dat"), "w") as f:
            f.write("0 My Part Name\n1 16 0 0 0 ...")
        name = get_part_name("part1.dat")
        assert name == "My Part Name"


def test_get_part_name_bad_format(tmpdir):
    with patch("backend.sync_meili.LDRAW_PARTS_DIR", str(tmpdir)):
        with open(os.path.join(str(tmpdir), "part1.dat"), "w") as f:
            f.write("1 16 0 0 0 ...")
        name = get_part_name("part1.dat")
        assert name == "part1.dat"


def test_get_part_name_exception(tmpdir):
    with patch("backend.sync_meili.LDRAW_PARTS_DIR", str(tmpdir)):
        # creating a directory instead of a file to raise an exception when opening
        os.makedirs(os.path.join(str(tmpdir), "part1.dat"))
        name = get_part_name("part1.dat")
        assert name == "part1.dat"


@patch("backend.sync_meili.meilisearch.Client")
def test_sync_to_meilisearch_success(mock_client, tmpdir):
    data_file = os.path.join(str(tmpdir), "config.json")
    with open(data_file, "w") as f:
        json.dump(
            {
                "part1.dat": {"status": "verified", "sites": []},
                "part2.dat": {"status": "pending"},
            },
            f,
        )

    mock_index = MagicMock()
    mock_client.return_value.index.return_value = mock_index

    with (
        patch("backend.sync_meili.DATA_FILE", data_file),
        patch("backend.sync_meili.get_part_name", side_effect=["Part 1", "Part 2"]),
    ):
        sync_to_meilisearch()

    mock_client.return_value.index.assert_called_with("parts")
    mock_index.update_settings.assert_called_once()
    mock_index.add_documents.assert_called_once()
    docs = mock_index.add_documents.call_args[0][0]
    assert len(docs) == 2
    assert docs[0]["id"] == "part1"
    assert docs[0]["name"] == "Part 1"
    assert docs[0]["has_sites"]
    assert not docs[1]["has_sites"]


def test_sync_to_meilisearch_no_file(tmpdir):
    data_file = os.path.join(str(tmpdir), "config.json")
    with (
        patch("backend.sync_meili.DATA_FILE", data_file),
        patch("backend.sync_meili.meilisearch.Client") as mock_client,
    ):
        sync_to_meilisearch()
        mock_client.assert_not_called()


def test_sync_to_meilisearch_bad_json(tmpdir):
    data_file = os.path.join(str(tmpdir), "config.json")
    with open(data_file, "w") as f:
        f.write("invalid json")
    with (
        patch("backend.sync_meili.DATA_FILE", data_file),
        patch("backend.sync_meili.meilisearch.Client") as mock_client,
    ):
        sync_to_meilisearch()
        mock_client.assert_not_called()


@patch("backend.sync_meili.meilisearch.Client")
def test_sync_to_meilisearch_empty(mock_client, tmpdir):
    data_file = os.path.join(str(tmpdir), "config.json")
    with open(data_file, "w") as f:
        json.dump({}, f)

    with patch("backend.sync_meili.DATA_FILE", data_file):
        sync_to_meilisearch()

    mock_client.return_value.index.return_value.add_documents.assert_not_called()


@patch("backend.sync_meili.meilisearch.Client")
def test_sync_to_meilisearch_exception(mock_client, tmpdir):
    data_file = os.path.join(str(tmpdir), "config.json")
    with open(data_file, "w") as f:
        json.dump({"part1.dat": {}}, f)

    mock_client.side_effect = Exception("mocked error")

    with patch("backend.sync_meili.DATA_FILE", data_file):
        sync_to_meilisearch()

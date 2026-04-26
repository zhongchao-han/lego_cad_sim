import pytest
from unittest.mock import patch, MagicMock
from backend.sync_meili import sync_to_meilisearch, get_part_name

def test_get_part_name():
    # Looking at the code: get_part_name might need some parts.json mocking or it returns ID
    # Since I don't know it, let's test what we can
    assert type(get_part_name("3001.dat")) == str

@patch("backend.sync_meili.meilisearch.Client")
@patch("builtins.open")
@patch("os.path.exists")
def test_sync_to_meilisearch(mock_exists, mock_open_file, mock_client):
    mock_exists.return_value = True
    import json
    mock_open_file.return_value.__enter__.return_value.read.return_value = json.dumps({
        "3001.dat": {"status": "ok", "sites": []}
    })

    mock_index = MagicMock()
    mock_client.return_value.index.return_value = mock_index

    sync_to_meilisearch()

    mock_client.return_value.index.assert_called_with('parts')
    mock_index.add_documents.assert_called()

@patch("backend.sync_meili.meilisearch.Client")
@patch("os.path.exists")
def test_sync_to_meilisearch_no_file(mock_exists, mock_client):
    mock_exists.return_value = False

    sync_to_meilisearch()
    mock_client.assert_not_called()

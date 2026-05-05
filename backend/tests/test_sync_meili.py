import pytest
from unittest.mock import patch, mock_open, MagicMock
from backend.sync_meili import get_part_name, sync_to_meilisearch
import json

@patch("backend.sync_meili._get_part_name")
def test_get_part_name(mock_get_part_name):
    mock_get_part_name.return_value = "Test Part"
    result = get_part_name("test.dat")
    assert result == "Test Part"
    mock_get_part_name.assert_called_once()

@patch("backend.sync_meili.os.path.exists")
def test_sync_to_meilisearch_no_config(mock_exists):
    mock_exists.return_value = False
    # Should exit early and not throw
    sync_to_meilisearch()

@patch("backend.sync_meili.os.path.exists")
@patch("builtins.open", new_callable=mock_open, read_data="invalid json")
def test_sync_to_meilisearch_json_error(mock_open_file, mock_exists):
    mock_exists.return_value = True
    # Should catch exception and not throw
    sync_to_meilisearch()

@patch("backend.sync_meili.os.path.exists")
@patch("builtins.open", new_callable=mock_open, read_data="{}")
@patch("backend.sync_meili.meilisearch.Client")
def test_sync_to_meilisearch_empty_documents(mock_client, mock_open_file, mock_exists):
    mock_exists.return_value = True

    mock_instance = MagicMock()
    mock_client.return_value = mock_instance
    mock_index = MagicMock()
    mock_instance.index.return_value = mock_index

    sync_to_meilisearch()

    mock_index.add_documents.assert_not_called()

@patch("backend.sync_meili.os.path.exists")
@patch("builtins.open", new_callable=mock_open)
@patch("backend.sync_meili.meilisearch.Client")
@patch("backend.sync_meili.get_part_name")
def test_sync_to_meilisearch_success(mock_get_part_name, mock_client, mock_open_file, mock_exists):
    mock_exists.return_value = True
    mock_get_part_name.return_value = "Test Part Name"

    config_data = {
        "32269.dat": {
            "status": "verified",
            "confidence": 1.0,
            "sites": []
        }
    }
    mock_open_file.return_value.read.return_value = json.dumps(config_data)

    mock_instance = MagicMock()
    mock_client.return_value = mock_instance
    mock_index = MagicMock()
    mock_instance.index.return_value = mock_index

    sync_to_meilisearch()

    mock_index.update_settings.assert_called_once()
    mock_index.add_documents.assert_called_once()

    called_args = mock_index.add_documents.call_args[0][0]
    assert len(called_args) == 1
    assert called_args[0]["id"] == "32269"
    assert called_args[0]["part_num"] == "32269"
    assert called_args[0]["name"] == "Test Part Name"
    assert called_args[0]["has_sites"] == True

@patch("backend.sync_meili.os.path.exists")
@patch("builtins.open", new_callable=mock_open, read_data='{"test.dat": {}}')
@patch("backend.sync_meili.meilisearch.Client")
def test_sync_to_meilisearch_client_exception(mock_client, mock_open_file, mock_exists):
    mock_exists.return_value = True
    mock_client.side_effect = Exception("MeiliSearch connection failed")

    # Should catch exception and log it, not throw
    sync_to_meilisearch()

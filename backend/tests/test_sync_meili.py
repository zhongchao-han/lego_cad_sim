import pytest
import os
from unittest.mock import patch, mock_open, MagicMock
from backend.sync_meili import get_part_name, sync_to_meilisearch

class TestSyncMeili:
    @patch('os.path.exists')
    def test_get_part_name_no_file(self, mock_exists):
        mock_exists.return_value = False
        name = get_part_name("123.dat")
        assert name == "123.dat"

    @patch('os.path.exists')
    @patch('builtins.open', new_callable=mock_open, read_data="0 Name of part\n1 16 0 0 0 ...")
    def test_get_part_name_success(self, mock_file, mock_exists):
        mock_exists.return_value = True
        name = get_part_name("123.dat")
        assert name == "Name of part"

    @patch('os.path.exists')
    @patch('builtins.open', new_callable=mock_open, read_data="1 16 0 0 0 ...\n")
    def test_get_part_name_invalid_format(self, mock_file, mock_exists):
        mock_exists.return_value = True
        name = get_part_name("123.dat")
        assert name == "123.dat"

    @patch('backend.sync_meili.meilisearch.Client')
    @patch('os.path.exists')
    @patch('builtins.open', new_callable=mock_open, read_data='{"123.dat": {"status": "verified", "sites": []}}')
    @patch('backend.sync_meili.get_part_name')
    def test_sync_to_meilisearch(self, mock_get_name, mock_file, mock_exists, mock_client):
        mock_exists.return_value = True
        mock_get_name.return_value = "Test Part"

        mock_index = MagicMock()
        mock_client.return_value.index.return_value = mock_index

        sync_to_meilisearch()

        mock_client.assert_called_once()
        mock_index.update_settings.assert_called_once()
        mock_index.add_documents.assert_called_once()

        docs = mock_index.add_documents.call_args[0][0]
        assert len(docs) == 1
        assert docs[0]["id"] == "123"
        assert docs[0]["part_num"] == "123"
        assert docs[0]["name"] == "Test Part"
        assert docs[0]["status"] == "verified"
        assert docs[0]["has_sites"] is True

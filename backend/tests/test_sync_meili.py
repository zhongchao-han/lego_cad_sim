import unittest
from unittest.mock import patch, MagicMock, mock_open
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.sync_meili import get_part_name, sync_to_meilisearch

class TestSyncMeili(unittest.TestCase):
    @patch('os.path.exists')
    @patch('builtins.open', new_callable=mock_open, read_data="0 Test Part Name\n1 16 0 0 0 ...")
    def test_get_part_name_success(self, mock_file, mock_exists):
        mock_exists.return_value = True

        name = get_part_name("1234.dat")
        self.assertEqual(name, "Test Part Name")

    @patch('os.path.exists')
    def test_get_part_name_not_exists(self, mock_exists):
        mock_exists.return_value = False
        name = get_part_name("1234.dat")
        self.assertEqual(name, "1234.dat")

    @patch('os.path.exists')
    @patch('builtins.open', new_callable=mock_open, read_data="1 16 0 0 0\n2 ...")
    def test_get_part_name_bad_format(self, mock_file, mock_exists):
        mock_exists.return_value = True
        name = get_part_name("1234.dat")
        self.assertEqual(name, "1234.dat")

    @patch('backend.sync_meili.meilisearch.Client')
    @patch('os.path.exists')
    @patch('builtins.open', new_callable=mock_open, read_data='{"1234.dat": {"status": "verified", "sites": []}}')
    @patch('backend.sync_meili.get_part_name', return_value="Test Part Name")
    def test_sync_to_meilisearch_success(self, mock_get_name, mock_file, mock_exists, mock_meili_client):
        mock_exists.return_value = True
        mock_client_instance = MagicMock()
        mock_meili_client.return_value = mock_client_instance

        mock_index = MagicMock()
        mock_client_instance.index.return_value = mock_index

        sync_to_meilisearch()

        mock_client_instance.index.assert_called()
        mock_index.update_settings.assert_called_once()
        mock_index.add_documents.assert_called_once()

        # Verify document content
        added_docs = mock_index.add_documents.call_args[0][0]
        self.assertEqual(len(added_docs), 1)
        doc = added_docs[0]
        self.assertEqual(doc["id"], "1234")
        self.assertEqual(doc["name"], "Test Part Name")
        self.assertEqual(doc["has_sites"], True)

    @patch('os.path.exists')
    def test_sync_to_meilisearch_no_file(self, mock_exists):
        mock_exists.return_value = False
        # Should exit gracefully without calling open
        with patch('builtins.open', new_callable=mock_open) as mock_file:
            sync_to_meilisearch()
            mock_file.assert_not_called()

if __name__ == "__main__":
    unittest.main()

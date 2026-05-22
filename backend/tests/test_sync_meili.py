import os
import sys
import json
import unittest
from unittest.mock import patch, mock_open, MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.sync_meili import sync_to_meilisearch, get_part_name


class TestSyncMeili(unittest.TestCase):

    @patch("backend.sync_meili._get_part_name")
    def test_get_part_name(self, mock_gpn):
        mock_gpn.return_value = "Test Part"
        res = get_part_name("test.dat")
        self.assertEqual(res, "Test Part")
        mock_gpn.assert_called_once()

    @patch("backend.sync_meili.os.path.exists")
    def test_sync_no_data_file(self, mock_exists):
        mock_exists.return_value = False
        # Should return without doing anything
        try:
            sync_to_meilisearch()
        except Exception as e:
            self.fail(f"Should not raise exception: {e}")

    @patch("backend.sync_meili.os.path.exists")
    def test_sync_json_load_error(self, mock_exists):
        mock_exists.return_value = True
        with patch("builtins.open", mock_open(read_data="invalid json")):
            try:
                sync_to_meilisearch()
            except Exception as e:
                self.fail(f"Should silently fail on json load: {e}")

    @patch("backend.sync_meili.meilisearch.Client")
    @patch("backend.sync_meili.os.path.exists")
    def test_sync_meili_client_error(self, mock_exists, mock_client):
        mock_exists.return_value = True
        mock_client.side_effect = Exception("Meili connection error")

        valid_json = json.dumps({"3001.dat": {"status": "verified"}})

        with patch("builtins.open", mock_open(read_data=valid_json)):
            try:
                sync_to_meilisearch()
            except Exception as e:
                self.fail(f"Should silently fail on meili error: {e}")

    @patch("backend.sync_meili.get_part_name")
    @patch("backend.sync_meili.meilisearch.Client")
    @patch("backend.sync_meili.os.path.exists")
    def test_sync_success_no_documents(self, mock_exists, mock_client, mock_gpn):
        mock_exists.return_value = True
        empty_json = json.dumps({})

        with patch("builtins.open", mock_open(read_data=empty_json)):
            sync_to_meilisearch()

        mock_client.assert_called_once()
        # Ensure that add_documents wasn't called because docs list is empty
        mock_client.return_value.index.return_value.add_documents.assert_not_called()

    @patch("backend.sync_meili.get_part_name")
    @patch("backend.sync_meili.meilisearch.Client")
    @patch("backend.sync_meili.os.path.exists")
    def test_sync_success_with_documents(self, mock_exists, mock_client, mock_gpn):
        mock_exists.return_value = True
        mock_gpn.return_value = "Brick 2 x 4"

        valid_json = json.dumps({
            "3001.dat": {
                "status": "verified",
                "confidence": 1.0,
                "sites": []
            }
        })

        mock_index = MagicMock()
        mock_client.return_value.index.return_value = mock_index

        with patch("builtins.open", mock_open(read_data=valid_json)):
            sync_to_meilisearch()

        mock_client.assert_called_once()
        mock_index.update_settings.assert_called_once()

        # Check docs added
        args, kwargs = mock_index.add_documents.call_args
        docs = args[0]
        self.assertEqual(len(docs), 1)

        doc = docs[0]
        self.assertEqual(doc["id"], "3001")
        self.assertEqual(doc["part_num"], "3001")
        self.assertEqual(doc["name"], "Brick 2 x 4")
        self.assertEqual(doc["status"], "verified")
        self.assertEqual(doc["confidence"], 1.0)
        self.assertTrue(doc["has_sites"])

if __name__ == "__main__":
    unittest.main()

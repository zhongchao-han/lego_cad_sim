import os
import json
import pytest
from unittest.mock import patch, mock_open, MagicMock

from backend.sync_meili import sync_to_meilisearch, get_part_name

class TestSyncMeili:
    @patch("backend.sync_meili.os.path.exists")
    @patch("backend.sync_meili.logger")
    def test_sync_no_data_file(self, mock_logger, mock_exists):
        mock_exists.return_value = False
        sync_to_meilisearch()
        mock_logger.error.assert_called()
        assert "配置文件未找到" in mock_logger.error.call_args[0][0]

    @patch("backend.sync_meili.os.path.exists")
    @patch("builtins.open", new_callable=mock_open, read_data="invalid json")
    @patch("backend.sync_meili.logger")
    def test_sync_json_load_fail(self, mock_logger, mock_file, mock_exists):
        mock_exists.return_value = True
        sync_to_meilisearch()
        mock_logger.error.assert_called()
        assert "加载 JSON 配置文件失败" in mock_logger.error.call_args[0][0]

    @patch("backend.sync_meili.os.path.exists")
    @patch("builtins.open", new_callable=mock_open, read_data="{}")
    @patch("backend.sync_meili.meilisearch.Client")
    @patch("backend.sync_meili.logger")
    def test_sync_empty_documents(self, mock_logger, mock_client_cls, mock_file, mock_exists):
        mock_exists.return_value = True
        # Meili client will be created but no documents added since JSON is {}
        sync_to_meilisearch()
        mock_client_cls.assert_called_once()
        mock_logger.warning.assert_called_with("没有需要同步的文档。")

    @patch("backend.sync_meili.os.path.exists")
    @patch("builtins.open", new_callable=mock_open, read_data='{"32269.dat": {"status": "verified", "sites": []}}')
    @patch("backend.sync_meili.meilisearch.Client")
    @patch("backend.sync_meili.get_part_name")
    def test_sync_success(self, mock_get_name, mock_client_cls, mock_file, mock_exists):
        mock_exists.return_value = True
        mock_get_name.return_value = "Technic Gear 20 Tooth"

        mock_client_instance = MagicMock()
        mock_index_instance = MagicMock()
        mock_client_cls.return_value = mock_client_instance
        mock_client_instance.index.return_value = mock_index_instance

        sync_to_meilisearch()

        mock_client_cls.assert_called_once()
        mock_client_instance.index.assert_any_call("parts")

        # Verify document format
        added_docs = mock_index_instance.add_documents.call_args[0][0]
        assert len(added_docs) == 1
        doc = added_docs[0]
        assert doc["id"] == "32269"
        assert doc["part_num"] == "32269"
        assert doc["name"] == "Technic Gear 20 Tooth"
        assert doc["category"] == "Gear"
        assert doc["status"] == "verified"
        assert doc["has_sites"] is True

        # Verify settings update
        mock_client_instance.index("parts").update_settings.assert_called_once()
        settings = mock_client_instance.index("parts").update_settings.call_args[0][0]
        assert "searchableAttributes" in settings
        assert "filterableAttributes" in settings
        assert "synonyms" in settings

    @patch("backend.sync_meili.os.path.exists")
    @patch("builtins.open", new_callable=mock_open, read_data='{"123.dat": {}}')
    @patch("backend.sync_meili.meilisearch.Client")
    @patch("backend.sync_meili.logger")
    def test_sync_meilisearch_exception(self, mock_logger, mock_client_cls, mock_file, mock_exists):
        mock_exists.return_value = True
        mock_client_cls.side_effect = Exception("Connection Refused")

        sync_to_meilisearch()

        mock_logger.error.assert_called()
        assert "同步至 MeiliSearch 时发生错误" in mock_logger.error.call_args[0][0]

    @patch("backend.sync_meili._get_part_name")
    def test_get_part_name_wrapper(self, mock_get_part_name):
        mock_get_part_name.return_value = "Test Part"
        result = get_part_name("123.dat")
        assert result == "Test Part"
        # It should pass the part_id and LDRAW_PARTS_DIR
        mock_get_part_name.assert_called_once()
        assert mock_get_part_name.call_args[0][0] == "123.dat"

import os
import json
import pytest
import logging
from unittest.mock import patch, mock_open, MagicMock
from backend.sync_meili import sync_to_meilisearch, get_part_name, logger

def test_get_part_name():
    with patch("backend.sync_meili._get_part_name") as mock_get_part_name:
        mock_get_part_name.return_value = "Mocked Part Name"
        assert get_part_name("123.dat") == "Mocked Part Name"
        mock_get_part_name.assert_called_once()

@patch("backend.sync_meili.meilisearch.Client")
@patch("os.path.exists")
def test_sync_to_meilisearch_no_data_file(mock_exists, mock_meili_client, caplog):
    caplog.set_level(logging.INFO)
    mock_exists.return_value = False
    sync_to_meilisearch()
    assert "未找到" in caplog.text
    mock_meili_client.assert_not_called()

@patch("backend.sync_meili.meilisearch.Client")
@patch("os.path.exists")
@patch("builtins.open", new_callable=mock_open, read_data="invalid json")
def test_sync_to_meilisearch_invalid_json(mock_file, mock_exists, mock_meili_client, caplog):
    caplog.set_level(logging.INFO)
    mock_exists.return_value = True
    sync_to_meilisearch()
    assert "加载 JSON 配置文件失败" in caplog.text
    mock_meili_client.assert_not_called()

@patch("backend.sync_meili.meilisearch.Client")
@patch("os.path.exists")
def test_sync_to_meilisearch_success(mock_exists, mock_client, caplog):
    caplog.set_level(logging.INFO)
    mock_exists.return_value = True
    test_data = {
        "3001.dat": {
            "status": "verified",
            "confidence": 0.9,
            "sites": []
        }
    }

    mock_index = MagicMock()
    mock_client.return_value.index.return_value = mock_index

    with patch("json.load", return_value=test_data), \
         patch("builtins.open", mock_open()), \
         patch("backend.sync_meili.get_part_name", return_value="Brick 2 x 4"):
        sync_to_meilisearch()

    mock_index.update_settings.assert_called_once()
    mock_index.add_documents.assert_called_once()
    assert "文档同步任务已全部提交" in caplog.text

@patch("backend.sync_meili.meilisearch.Client")
@patch("os.path.exists")
def test_sync_to_meilisearch_empty_data(mock_exists, mock_client, caplog):
    caplog.set_level(logging.INFO)
    mock_exists.return_value = True
    test_data = {}

    mock_index = MagicMock()
    mock_client.return_value.index.return_value = mock_index

    with patch("json.load", return_value=test_data), patch("builtins.open", mock_open()):
        sync_to_meilisearch()

    mock_index.update_settings.assert_not_called()
    mock_index.add_documents.assert_not_called()
    assert "没有需要同步的文档" in caplog.text

@patch("backend.sync_meili.meilisearch.Client")
@patch("os.path.exists")
def test_sync_to_meilisearch_exception(mock_exists, mock_client, caplog):
    caplog.set_level(logging.INFO)
    mock_exists.return_value = True
    test_data = {
        "3001.dat": {
            "status": "verified",
            "confidence": 0.9,
            "sites": []
        }
    }

    mock_client.side_effect = Exception("Meili Error")

    with patch("json.load", return_value=test_data), patch("builtins.open", mock_open()):
        sync_to_meilisearch()

    assert "同步至 MeiliSearch 时发生错误" in caplog.text

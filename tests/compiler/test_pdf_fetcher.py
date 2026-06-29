from unittest.mock import MagicMock, patch
import pytest
from compiler.pdf_fetcher import fetch_pdf


def test_fetch_pdf_returns_bytes():
    mock_response = MagicMock()
    mock_response.content = b"%PDF-1.4 fake content"
    mock_response.headers = {"content-type": "application/pdf"}
    mock_response.raise_for_status = MagicMock()

    with patch("compiler.pdf_fetcher.requests.get", return_value=mock_response):
        result = fetch_pdf("https://example.com/rulebook.pdf")

    assert result == b"%PDF-1.4 fake content"


def test_fetch_pdf_raises_on_http_error():
    mock_response = MagicMock()
    mock_response.raise_for_status.side_effect = Exception("404 Not Found")

    with patch("compiler.pdf_fetcher.requests.get", return_value=mock_response):
        with pytest.raises(Exception, match="404"):
            fetch_pdf("https://example.com/missing.pdf")

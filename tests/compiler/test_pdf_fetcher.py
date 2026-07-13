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


def test_fetch_pdf_sends_browser_user_agent():
    mock_response = MagicMock()
    mock_response.content = b"%PDF-1.4 fake content"
    mock_response.headers = {"content-type": "application/pdf"}
    mock_response.raise_for_status = MagicMock()

    with patch("compiler.pdf_fetcher.requests.get", return_value=mock_response) as mock_get:
        fetch_pdf("https://boardgamegeek.com/file/download_redirect/token/rules.pdf")

    assert "User-Agent" in mock_get.call_args.kwargs["headers"]


def test_fetch_pdf_raises_when_response_is_not_a_pdf():
    mock_response = MagicMock()
    mock_response.content = b"<html>Just a moment...</html>"
    mock_response.headers = {"content-type": "text/html"}
    mock_response.raise_for_status = MagicMock()

    with patch("compiler.pdf_fetcher.requests.get", return_value=mock_response):
        with pytest.raises(ValueError, match="did not return a PDF"):
            fetch_pdf("https://boardgamegeek.com/file/download_redirect/token/rules.pdf")

from unittest.mock import MagicMock, patch
import pytest
from compiler.web_searcher import search_rulebook_pdf


def _mock_tavily_response(urls):
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {
        "results": [{"url": u} for u in urls]
    }
    return mock_resp


def _mock_head_pdf(url):
    mock_resp = MagicMock()
    mock_resp.headers = {"Content-Type": "application/pdf"}
    return mock_resp


def _mock_head_not_pdf(url):
    mock_resp = MagicMock()
    mock_resp.headers = {"Content-Type": "text/html"}
    return mock_resp


def test_returns_first_valid_pdf_url():
    pdf_url = "https://example.com/root-rulebook.pdf"
    with (
        patch("compiler.web_searcher.requests.post",
              return_value=_mock_tavily_response([pdf_url])),
        patch("compiler.web_searcher.requests.head",
              return_value=_mock_head_pdf(pdf_url)),
    ):
        result = search_rulebook_pdf("Root", "fake-key")
    assert result == pdf_url


def test_skips_url_that_is_not_pdf_content_type():
    non_pdf_url = "https://example.com/fakebook.pdf"  # looks like PDF, but isn't
    pdf_url = "https://example.com/rules.pdf"
    def fake_head(url, **kw):
        resp = MagicMock()
        if url == non_pdf_url:
            resp.headers = {"Content-Type": "text/html"}
        else:
            resp.headers = {"Content-Type": "application/pdf"}
        return resp
    with (
        patch("compiler.web_searcher.requests.post",
              return_value=_mock_tavily_response([non_pdf_url, pdf_url])),
        patch("compiler.web_searcher.requests.head", side_effect=fake_head),
    ):
        result = search_rulebook_pdf("Root", "fake-key")
    assert result == pdf_url


def test_returns_none_when_no_pdf_results():
    with (
        patch("compiler.web_searcher.requests.post",
              return_value=_mock_tavily_response([])),
    ):
        result = search_rulebook_pdf("Root", "fake-key")
    assert result is None


def test_returns_none_when_tavily_request_fails():
    with patch("compiler.web_searcher.requests.post", side_effect=Exception("timeout")):
        result = search_rulebook_pdf("Root", "fake-key")
    assert result is None


def test_returns_none_when_head_check_fails():
    pdf_url = "https://example.com/rules.pdf"
    with (
        patch("compiler.web_searcher.requests.post",
              return_value=_mock_tavily_response([pdf_url])),
        patch("compiler.web_searcher.requests.head", side_effect=Exception("timeout")),
    ):
        result = search_rulebook_pdf("Root", "fake-key")
    assert result is None


def test_query_includes_game_name():
    captured = {}
    def capture_post(url, json=None, **kw):
        captured["json"] = json
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {"results": []}
        return resp

    with patch("compiler.web_searcher.requests.post", side_effect=capture_post):
        search_rulebook_pdf("Pandemic Legacy", "fake-key")

    assert "Pandemic Legacy" in captured["json"]["query"]

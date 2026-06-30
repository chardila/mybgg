from unittest.mock import MagicMock, patch
import pytest
from compiler.bgg_scraper import scrape_bgg_rulebook

BGG_HTML_WITH_RULEBOOK = """
<html><body>
  <a href="https://cf.geekdo-images.com/files/root-rulebook.pdf">Root Rulebook</a>
  <a href="https://cf.geekdo-images.com/files/root-insert.pdf">Insert Guide</a>
</body></html>
"""

BGG_HTML_RULEBOOK_IN_HREF = """
<html><body>
  <a href="https://cf.geekdo-images.com/files/rules-v2.pdf">Complete Guide</a>
</body></html>
"""

BGG_HTML_NO_PDF = """
<html><body>
  <a href="https://boardgamegeek.com/thread/123">Discussion</a>
</body></html>
"""


def _mock_get(html):
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.text = html
    return resp


def test_returns_pdf_url_with_rulebook_in_link_text():
    with patch("compiler.bgg_scraper.requests.get",
               return_value=_mock_get(BGG_HTML_WITH_RULEBOOK)):
        result = scrape_bgg_rulebook(237182)
    assert result == "https://cf.geekdo-images.com/files/root-rulebook.pdf"


def test_returns_pdf_url_with_rules_in_href():
    with patch("compiler.bgg_scraper.requests.get",
               return_value=_mock_get(BGG_HTML_RULEBOOK_IN_HREF)):
        result = scrape_bgg_rulebook(237182)
    assert result == "https://cf.geekdo-images.com/files/rules-v2.pdf"


def test_returns_none_when_no_pdf_found():
    with patch("compiler.bgg_scraper.requests.get",
               return_value=_mock_get(BGG_HTML_NO_PDF)):
        result = scrape_bgg_rulebook(237182)
    assert result is None


def test_returns_none_on_request_error():
    with patch("compiler.bgg_scraper.requests.get",
               side_effect=Exception("connection refused")):
        result = scrape_bgg_rulebook(237182)
    assert result is None


def test_uses_correct_bgg_url():
    captured = {}
    def capture_get(url, **kw):
        captured["url"] = url
        return _mock_get(BGG_HTML_NO_PDF)

    with patch("compiler.bgg_scraper.requests.get", side_effect=capture_get):
        scrape_bgg_rulebook(237182)

    assert captured["url"] == "https://boardgamegeek.com/boardgame/237182/files"


def test_sends_user_agent_header():
    captured = {}
    def capture_get(url, headers=None, **kw):
        captured["headers"] = headers
        return _mock_get(BGG_HTML_NO_PDF)

    with patch("compiler.bgg_scraper.requests.get", side_effect=capture_get):
        scrape_bgg_rulebook(237182)

    assert "mybgg-wiki-compiler" in captured["headers"].get("User-Agent", "")

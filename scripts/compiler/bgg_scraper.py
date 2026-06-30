import re
import requests
from bs4 import BeautifulSoup

_BGG_FILES_URL = "https://boardgamegeek.com/boardgame/{bgg_id}/files"
_HEADERS = {"User-Agent": "mybgg-wiki-compiler/1.0"}
_RULEBOOK_RE = re.compile(r"rule|rulebook|regla", re.IGNORECASE)


def scrape_bgg_rulebook(bgg_id: int) -> str | None:
    """Scrape BGG Files page for a rulebook PDF. Returns URL or None."""
    try:
        url = _BGG_FILES_URL.format(bgg_id=bgg_id)
        resp = requests.get(url, headers=_HEADERS, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"]
            if not href.lower().endswith(".pdf"):
                continue
            text = a_tag.get_text(strip=True)
            if _RULEBOOK_RE.search(text) or _RULEBOOK_RE.search(href):
                return href
        return None
    except Exception:
        return None

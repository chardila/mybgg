# PDF Acquisition Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent LLM fallback in the Knowledge Compiler with an explicit PDF acquisition cascade: manual URL → Tavily web search → BGG Files scrape → hard fail.

**Architecture:** Two new modules (`web_searcher.py`, `bgg_scraper.py`) are added to `scripts/compiler/`. The orchestrator `add_game.py` calls them in order inside a new `acquire_pdf()` helper. If no PDF is found by any step, the process raises `RuntimeError` and the GitHub Actions job fails visibly.

**Tech Stack:** Python 3.13, `requests` (already in deps), `beautifulsoup4` (new), Tavily Search REST API (POST JSON), `unittest.mock` for tests, `pytest`.

## Global Constraints

- All new files live under `scripts/compiler/` (source) and `tests/compiler/` (tests)
- Import paths use `compiler.` prefix (e.g. `from compiler.web_searcher import search_rulebook_pdf`) — `conftest.py` adds `scripts/` to `sys.path`
- `source` field values are: `pdf-manual`, `pdf-web`, `pdf-bgg` — the old `ai-generated` and `pdf` values are retired
- All HTTP calls (Tavily, BGG, HEAD checks) must be patched in tests — no real network calls
- `game_data["id"]` is the BGG integer ID (not `game_data["bgg_id"]`)
- Run tests from repo root: `pytest tests/compiler/ -v`

---

### Task 1: Add beautifulsoup4 dependency

**Files:**
- Modify: `scripts/requirements.in`
- Modify: `scripts/requirements.txt`

**Interfaces:**
- Produces: `beautifulsoup4` available for `from bs4 import BeautifulSoup` in `bgg_scraper.py`

- [ ] **Step 1: Add to requirements.in**

Open `scripts/requirements.in` and add one line after `requests`:
```
beautifulsoup4
```

- [ ] **Step 2: Install locally**

```bash
pip install beautifulsoup4
```

Expected: `Successfully installed beautifulsoup4-X.X.X`

- [ ] **Step 3: Add pinned entry to requirements.txt**

Open `scripts/requirements.txt` and add this block in alphabetical order (after `anyio`, before `certifi`):
```
beautifulsoup4==4.12.3
    # via -r requirements.in
```

Also add its dependency `soupsieve` in the `s` section:
```
soupsieve==2.5
    # via beautifulsoup4
```

- [ ] **Step 4: Verify import works**

```bash
python -c "from bs4 import BeautifulSoup; print('ok')"
```

Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add scripts/requirements.in scripts/requirements.txt
git commit -m "chore: add beautifulsoup4 dependency for BGG scraping"
```

---

### Task 2: Create web_searcher.py

**Files:**
- Create: `scripts/compiler/web_searcher.py`
- Create: `tests/compiler/test_web_searcher.py`

**Interfaces:**
- Consumes: `requests` (already installed), `TAVILY_API_KEY` string
- Produces: `search_rulebook_pdf(game_name: str, tavily_api_key: str) -> str | None`

- [ ] **Step 1: Write failing tests**

Create `tests/compiler/test_web_searcher.py`:

```python
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
    html_url = "https://example.com/page"
    pdf_url = "https://example.com/rules.pdf"
    responses = {html_url: _mock_head_not_pdf(html_url), pdf_url: _mock_head_pdf(pdf_url)}
    with (
        patch("compiler.web_searcher.requests.post",
              return_value=_mock_tavily_response([html_url, pdf_url])),
        patch("compiler.web_searcher.requests.head", side_effect=lambda url, **kw: responses[url]),
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/compiler/test_web_searcher.py -v
```

Expected: `ModuleNotFoundError: No module named 'compiler.web_searcher'`

- [ ] **Step 3: Write the implementation**

Create `scripts/compiler/web_searcher.py`:

```python
import requests

TAVILY_SEARCH_URL = "https://api.tavily.com/search"


def search_rulebook_pdf(game_name: str, tavily_api_key: str) -> str | None:
    """Search Tavily for a rulebook PDF. Returns first valid PDF URL or None."""
    query = f'"{game_name}" rulebook PDF filetype:pdf'
    try:
        resp = requests.post(
            TAVILY_SEARCH_URL,
            json={"api_key": tavily_api_key, "query": query, "max_results": 5},
            timeout=15,
        )
        resp.raise_for_status()
    except Exception:
        return None

    for result in resp.json().get("results", []):
        url = result.get("url", "")
        if _looks_like_pdf_url(url) and _is_pdf_content(url):
            return url
    return None


def _looks_like_pdf_url(url: str) -> bool:
    u = url.lower()
    return u.endswith(".pdf") or "/pdf" in u or "pdf=" in u


def _is_pdf_content(url: str) -> bool:
    try:
        resp = requests.head(url, timeout=10, allow_redirects=True)
        return "application/pdf" in resp.headers.get("Content-Type", "")
    except Exception:
        return False
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pytest tests/compiler/test_web_searcher.py -v
```

Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/web_searcher.py tests/compiler/test_web_searcher.py
git commit -m "feat: add Tavily web search for rulebook PDFs"
```

---

### Task 3: Create bgg_scraper.py

**Files:**
- Create: `scripts/compiler/bgg_scraper.py`
- Create: `tests/compiler/test_bgg_scraper.py`

**Interfaces:**
- Consumes: `requests`, `beautifulsoup4`
- Produces: `scrape_bgg_rulebook(bgg_id: int) -> str | None`

- [ ] **Step 1: Write failing tests**

Create `tests/compiler/test_bgg_scraper.py`:

```python
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/compiler/test_bgg_scraper.py -v
```

Expected: `ModuleNotFoundError: No module named 'compiler.bgg_scraper'`

- [ ] **Step 3: Write the implementation**

Create `scripts/compiler/bgg_scraper.py`:

```python
import re
import requests
from bs4 import BeautifulSoup

_BGG_FILES_URL = "https://boardgamegeek.com/boardgame/{bgg_id}/files"
_HEADERS = {"User-Agent": "mybgg-wiki-compiler/1.0"}
_RULEBOOK_RE = re.compile(r"rule|rulebook|regla", re.IGNORECASE)


def scrape_bgg_rulebook(bgg_id: int) -> str | None:
    """Scrape BGG Files page for a rulebook PDF. Returns URL or None."""
    url = _BGG_FILES_URL.format(bgg_id=bgg_id)
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=15)
        resp.raise_for_status()
    except Exception:
        return None

    soup = BeautifulSoup(resp.text, "html.parser")
    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"]
        if not href.lower().endswith(".pdf"):
            continue
        text = a_tag.get_text(strip=True)
        if _RULEBOOK_RE.search(text) or _RULEBOOK_RE.search(href):
            return href
    return None
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pytest tests/compiler/test_bgg_scraper.py -v
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/bgg_scraper.py tests/compiler/test_bgg_scraper.py
git commit -m "feat: add BGG Files scraper for rulebook PDFs"
```

---

### Task 4: Update add_game.py cascade and tests

**Files:**
- Modify: `scripts/compiler/add_game.py`
- Modify: `tests/compiler/test_add_game.py`

**Interfaces:**
- Consumes:
  - `search_rulebook_pdf(game_name: str, tavily_api_key: str) -> str | None` from `compiler.web_searcher`
  - `scrape_bgg_rulebook(bgg_id: int) -> str | None` from `compiler.bgg_scraper`
- Produces: `acquire_pdf(game_data: dict, pdf_url: str | None, tavily_key: str | None) -> tuple[bytes, str, str | None]`
  - Returns `(pdf_bytes, source_label, resolved_url)` where `source_label` is one of `"pdf-manual"`, `"pdf-web"`, `"pdf-bgg"`
  - Raises `RuntimeError` if no PDF is found

- [ ] **Step 1: Replace test file**

Replace the entire content of `tests/compiler/test_add_game.py`:

```python
import sys
from unittest.mock import MagicMock, patch
import pytest


GAME_DATA = {
    "id": 237182, "name": "Root", "slug": "root",
    "description": "A game.", "mechanics": ["Area Control"],
    "categories": ["Animals"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "3.72", "rank": "21", "playing_time": "60",
}

FULL_SECTIONS = {
    "index": "# Root", "setup": "Setup", "rules": "Rules",
    "teaching": "Teaching", "faq": "FAQ", "glossary": "Glossary",
}


# ── acquire_pdf unit tests ──────────────────────────────────────────────────

def test_acquire_pdf_uses_manual_url():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF manual") as mock_fetch,
    ):
        pdf_bytes, source, resolved_url = acquire_pdf(GAME_DATA, "https://example.com/root.pdf", "key")

    assert pdf_bytes == b"%PDF manual"
    assert source == "pdf-manual"
    assert resolved_url == "https://example.com/root.pdf"
    mock_fetch.assert_called_once_with("https://example.com/root.pdf")


def test_acquire_pdf_uses_tavily_when_no_url():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.search_rulebook_pdf", return_value="https://found.com/rules.pdf"),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF web") as mock_fetch,
    ):
        pdf_bytes, source, resolved_url = acquire_pdf(GAME_DATA, None, "tavily-key")

    assert pdf_bytes == b"%PDF web"
    assert source == "pdf-web"
    assert resolved_url == "https://found.com/rules.pdf"
    mock_fetch.assert_called_once_with("https://found.com/rules.pdf")


def test_acquire_pdf_falls_back_to_bgg_when_tavily_fails():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.search_rulebook_pdf", return_value=None),
        patch("compiler.add_game.scrape_bgg_rulebook", return_value="https://bgg.com/rules.pdf"),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF bgg") as mock_fetch,
    ):
        pdf_bytes, source, resolved_url = acquire_pdf(GAME_DATA, None, "tavily-key")

    assert pdf_bytes == b"%PDF bgg"
    assert source == "pdf-bgg"
    assert resolved_url == "https://bgg.com/rules.pdf"
    mock_fetch.assert_called_once_with("https://bgg.com/rules.pdf")


def test_acquire_pdf_skips_tavily_when_no_key():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.search_rulebook_pdf") as mock_tavily,
        patch("compiler.add_game.scrape_bgg_rulebook", return_value="https://bgg.com/rules.pdf"),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF bgg"),
    ):
        _, source, _ = acquire_pdf(GAME_DATA, None, None)

    mock_tavily.assert_not_called()
    assert source == "pdf-bgg"


def test_acquire_pdf_raises_when_nothing_found():
    from compiler.add_game import acquire_pdf
    with (
        patch("compiler.add_game.search_rulebook_pdf", return_value=None),
        patch("compiler.add_game.scrape_bgg_rulebook", return_value=None),
    ):
        with pytest.raises(RuntimeError, match="Could not find a rulebook PDF"):
            acquire_pdf(GAME_DATA, None, "tavily-key")


# ── main() integration tests ────────────────────────────────────────────────

def test_main_with_pdf_url(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA),
        patch("compiler.add_game.acquire_pdf", return_value=(b"%PDF", "pdf-manual", "https://example.com/root.pdf")),
        patch("compiler.add_game.extract_text", return_value="Rules text"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": "bgg-token"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path))

    write_args = mock_write.call_args[0]
    assert write_args[4] == "pdf-manual"


def test_main_fails_when_no_pdf_found(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA),
        patch("compiler.add_game.acquire_pdf", side_effect=RuntimeError("Could not find a rulebook PDF")),
        patch("compiler.add_game.DeepSeekProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=237182, pdf_url=None, status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/compiler/test_add_game.py -v
```

Expected: failures because `acquire_pdf` doesn't exist yet and `source="pdf"` / `"ai-generated"` is still the old behavior.

- [ ] **Step 3: Rewrite add_game.py**

Replace the entire content of `scripts/compiler/add_game.py`:

```python
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compiler.bgg_fetcher import fetch_game
from compiler.pdf_fetcher import fetch_pdf
from compiler.pdf_parser import extract_text
from compiler.llm_provider import DeepSeekProvider
from compiler.llm_compiler import compile_game
from compiler.wiki_writer import write_game
from compiler.web_searcher import search_rulebook_pdf
from compiler.bgg_scraper import scrape_bgg_rulebook


def acquire_pdf(
    game_data: dict,
    pdf_url: str | None,
    tavily_key: str | None,
) -> tuple[bytes, str, str | None]:
    """Return (pdf_bytes, source_label, resolved_url) or raise RuntimeError."""
    if pdf_url:
        print(f"Downloading PDF from {pdf_url}...")
        return fetch_pdf(pdf_url), "pdf-manual", pdf_url

    if tavily_key:
        print("No PDF URL — searching Tavily...")
        found_url = search_rulebook_pdf(game_data["name"], tavily_key)
        if found_url:
            print(f"Found via web search: {found_url}")
            return fetch_pdf(found_url), "pdf-web", found_url
    else:
        print("TAVILY_API_KEY not set — skipping web search.")

    print(f"Checking BGG Files for {game_data['name']}...")
    found_url = scrape_bgg_rulebook(game_data["id"])
    if found_url:
        print(f"Found in BGG Files: {found_url}")
        return fetch_pdf(found_url), "pdf-bgg", found_url

    raise RuntimeError(
        f"Could not find a rulebook PDF for '{game_data['name']}'. "
        "Provide a --pdf_url argument to proceed."
    )


def main(bgg_id: int, pdf_url: str | None, status: str, wiki_path: str) -> None:
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN") or None
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]
    tavily_key = os.environ.get("TAVILY_API_KEY") or None

    provider = DeepSeekProvider(api_key=deepseek_key)

    print(f"Fetching BGG data for game {bgg_id}...")
    game_data = fetch_game(bgg_id, token=bgg_token)
    print(f"Found: {game_data['name']} ({game_data['slug']})")

    try:
        pdf_bytes, source, resolved_url = acquire_pdf(game_data, pdf_url, tavily_key)
    except RuntimeError as e:
        print(f"Error: {e}")
        sys.exit(1)

    print("Extracting text from PDF...")
    rulebook_text = extract_text(pdf_bytes)
    print(f"Extracted {len(rulebook_text)} characters from PDF.")

    print("Compiling wiki sections (6 LLM calls)...")
    sections, failures = compile_game(game_data, rulebook_text, provider)

    if not sections:
        print(f"Error: all sections failed to generate: {failures}")
        sys.exit(1)

    print(f"Writing wiki files to {wiki_path}/games/{game_data['slug']}/...")
    write_game(game_data, sections, wiki_path, status, source, resolved_url)

    print(f"Done! Wiki for '{game_data['name']}' committed to {wiki_path}.")
    if failures:
        print(f"Warning: {len(failures)} section(s) failed: {failures}")
        sys.exit(len(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import a board game into the wiki")
    parser.add_argument("--bgg_id", type=int, required=True)
    parser.add_argument("--pdf_url", type=str, default=None)
    parser.add_argument("--status", type=str, required=True,
                        choices=["owned", "wishlist", "borrowed", "friend", "played", "archived"])
    parser.add_argument("--wiki_path", type=str, required=True)
    args = parser.parse_args()

    main(
        bgg_id=args.bgg_id,
        pdf_url=args.pdf_url if args.pdf_url else None,
        status=args.status,
        wiki_path=args.wiki_path,
    )
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pytest tests/compiler/test_add_game.py -v
```

Expected: all 7 tests PASS

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
pytest tests/compiler/ -v
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/compiler/add_game.py tests/compiler/test_add_game.py
git commit -m "feat: replace LLM fallback with PDF acquisition cascade"
```

---

### Task 5: Update GitHub Actions workflow

**Files:**
- Modify: `.github/workflows/import-game.yml`

**Interfaces:**
- Consumes: `TAVILY_API_KEY` GitHub Actions secret (must be added manually in repo settings)

- [ ] **Step 1: Update the workflow file**

Replace the content of `.github/workflows/import-game.yml`:

```yaml
name: Import game to wiki

on:
  workflow_dispatch:
    inputs:
      bgg_id:
        description: 'BGG Game ID (number in the BGG URL, e.g. 237182 for Root)'
        required: true
        type: string
      pdf_url:
        description: 'Direct URL to rulebook PDF (optional — searched automatically if omitted)'
        required: false
        type: string
        default: ''
      status:
        description: 'Ownership status'
        required: true
        type: choice
        default: 'owned'
        options:
          - owned
          - wishlist
          - borrowed
          - friend
          - played
          - archived

jobs:
  import:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout mybgg (code)
        uses: actions/checkout@v7

      - name: Checkout mybgg-wiki (content)
        uses: actions/checkout@v7
        with:
          repository: chardila/mybgg-wiki
          path: wiki
          token: ${{ secrets.WIKI_GITHUB_TOKEN }}

      - name: Setup Python
        uses: actions/setup-python@v6
        with:
          python-version: '3.13'
          cache: 'pip'

      - name: Install dependencies
        run: pip install -r scripts/requirements.txt

      - name: Configure git identity for wiki commits
        run: |
          git -C wiki config user.name "GitHub Actions"
          git -C wiki config user.email "actions@github.com"

      - name: Import game
        env:
          GAMECACHE_BGG_TOKEN: ${{ secrets.GAMECACHE_BGG_TOKEN }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          TAVILY_API_KEY: ${{ secrets.TAVILY_API_KEY }}
          BGG_ID: ${{ inputs.bgg_id }}
          PDF_URL: ${{ inputs.pdf_url }}
          STATUS: ${{ inputs.status }}
        run: |
          ARGS="--bgg_id $BGG_ID --status $STATUS --wiki_path wiki"
          if [ -n "$PDF_URL" ]; then
            ARGS="$ARGS --pdf_url $PDF_URL"
          fi
          python scripts/compiler/add_game.py $ARGS
```

- [ ] **Step 2: Add TAVILY_API_KEY secret in GitHub**

Go to `https://github.com/chardila/mybgg/settings/secrets/actions` and add:
- Name: `TAVILY_API_KEY`
- Value: your Tavily API key from `https://app.tavily.com`

- [ ] **Step 3: Commit the workflow change**

```bash
git add .github/workflows/import-game.yml
git commit -m "feat: add TAVILY_API_KEY to import-game workflow"
```

- [ ] **Step 4: Push**

```bash
git push origin master
```

- [ ] **Step 5: Smoke test**

Trigger the workflow from GitHub Actions UI (`chardila/mybgg` → Actions → "Import game to wiki" → Run workflow) with:
- `bgg_id`: `174430` (Gloomhaven — well-known game, likely findable)
- `pdf_url`: leave empty
- `status`: `owned`

Expected: workflow finds a PDF via Tavily or BGG and writes wiki files. If it fails, check the logs — the cascade prints which step it's trying.

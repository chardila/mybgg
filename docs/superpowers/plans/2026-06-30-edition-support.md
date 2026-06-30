# Edition Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add edition awareness to the compiler so each game's slug includes its publication year (e.g. `pandemic-2013`), with an optional manual override (e.g. `pandemic-kickstarter`).

**Architecture:** `yearpublished` is added to the BGG XML parser and propagated through `bgg_fetcher` → `add_game` → `llm_compiler` and `wiki_writer`. `add_game` introduces `_resolve_edition()` to compute the edition slug and mutates `game_data["slug"]` and `game_data["edition"]` before any downstream module sees it.

**Tech Stack:** Python 3.13, `declxml` (BGG XML parsing already in use), `pytest`, `unittest.mock`.

## Global Constraints

- `game_data["yearpublished"]` is an `int` (0 if BGG did not return it)
- `game_data["edition"]` is a `str` slug (year as string, or custom text run through `_to_slug`)
- Edition slug format: `{name-slug}-{edition}` — e.g. `pandemic-2013`, `root-kickstarter`
- `wiki_writer._build_frontmatter` uses `.get("edition", "unknown")` and `.get("yearpublished", 0)` so existing tests without these fields continue to pass
- `tests/compiler/__init__.py` must NOT exist
- Run tests from repo root: `pytest tests/compiler/ -v`
- All HTTP and BGG calls must be patched in tests — no real network calls

---

### Task 1: Add yearpublished to bgg_client.py and bgg_fetcher.py

**Files:**
- Modify: `scripts/gamecache/bgg_client.py` (inside `_games_list_to_games`, `game_processor` array)
- Modify: `scripts/compiler/bgg_fetcher.py` (returned dict in `fetch_game`)
- Modify: `tests/compiler/test_bgg_fetcher.py` (add field to mock, add 2 tests)

**Interfaces:**
- Produces: `game_data["yearpublished"]` — `int`, available to all later tasks

- [ ] **Step 1: Write failing tests**

Add to `tests/compiler/test_bgg_fetcher.py`. First update `BGG_GAME_DATA` to add `"yearpublished": "2018"`, then add two tests at the end of the file:

```python
# In BGG_GAME_DATA dict, add this key:
"yearpublished": "2018",
```

```python
def test_fetch_game_includes_yearpublished():
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = [BGG_GAME_DATA]
        mock_cls.return_value = mock_client
        result = fetch_game(237182)
    assert result["yearpublished"] == 2018


def test_fetch_game_yearpublished_defaults_to_zero():
    data_no_year = {k: v for k, v in BGG_GAME_DATA.items() if k != "yearpublished"}
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = [data_no_year]
        mock_cls.return_value = mock_client
        result = fetch_game(237182)
    assert result["yearpublished"] == 0
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/compiler/test_bgg_fetcher.py -v
```

Expected: `test_fetch_game_includes_yearpublished` and `test_fetch_game_yearpublished_defaults_to_zero` FAIL with `KeyError` or `AssertionError`.

- [ ] **Step 3: Add yearpublished to bgg_client.py XML processor**

In `scripts/gamecache/bgg_client.py`, inside `_games_list_to_games`, find the `game_processor` array. After the `xml.string("minage", ...)` line, add:

```python
xml.string("yearpublished", attribute="value", alias="yearpublished", required=False, default="0"),
```

The full block context (find the `minage` line and add after it):
```python
xml.string("minage", attribute="value", alias="min_age"),
xml.string("yearpublished", attribute="value", alias="yearpublished", required=False, default="0"),
```

- [ ] **Step 4: Add yearpublished to bgg_fetcher.py returned dict**

In `scripts/compiler/bgg_fetcher.py`, in `fetch_game`, add to the returned dict after `"playing_time"`:

```python
"yearpublished": int(raw.get("yearpublished", 0) or 0),
```

The full returned dict becomes:
```python
return {
    "id": raw["id"],
    "name": raw["name"],
    "slug": _to_slug(raw["name"]),
    "description": raw.get("description", ""),
    "mechanics": raw.get("mechanics", []),
    "categories": raw.get("categories", []),
    "players": players,
    "min_players": int(min_p),
    "max_players": int(max_p),
    "weight": str(raw.get("weight", "")),
    "rank": str(raw.get("rank", "")),
    "playing_time": str(raw.get("playing_time", "")),
    "yearpublished": int(raw.get("yearpublished", 0) or 0),
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
pytest tests/compiler/test_bgg_fetcher.py -v
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Run full suite to check for regressions**

```bash
pytest tests/compiler/ -v
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/gamecache/bgg_client.py scripts/compiler/bgg_fetcher.py tests/compiler/test_bgg_fetcher.py
git commit -m "feat: add yearpublished to BGG fetcher"
```

---

### Task 2: Add edition slug to add_game.py

**Files:**
- Modify: `scripts/compiler/add_game.py`
- Modify: `tests/compiler/test_add_game.py`

**Interfaces:**
- Consumes: `game_data["yearpublished"]` (int) from Task 1; `_to_slug` from `compiler.bgg_fetcher`
- Produces:
  - `_resolve_edition(game_data: dict, edition_override: str | None) -> str`
  - `game_data["slug"]` mutated to `"{name-slug}-{edition}"` before downstream use
  - `game_data["edition"]` set to the edition string
  - `main()` gains `edition: str | None = None` parameter

- [ ] **Step 1: Write failing tests**

Add to `tests/compiler/test_add_game.py`. First, update `GAME_DATA` at the top to include `yearpublished`:

```python
GAME_DATA = {
    "id": 237182, "name": "Root", "slug": "root",
    "description": "A game.", "mechanics": ["Area Control"],
    "categories": ["Animals"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "3.72", "rank": "21", "playing_time": "60",
    "yearpublished": 2018,
}
```

Then add these tests after the existing ones:

```python
# ── _resolve_edition unit tests ──────────────────────────────────────────────

def test_resolve_edition_uses_year_by_default():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 2018}, None) == "2018"


def test_resolve_edition_uses_override_when_provided():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 2018}, "Kickstarter Edition") == "kickstarter-edition"


def test_resolve_edition_returns_unknown_when_no_year():
    from compiler.add_game import _resolve_edition
    assert _resolve_edition({"yearpublished": 0}, None) == "unknown"


def test_main_slug_includes_edition(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]
        captured["edition"] = game_data["edition"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.acquire_pdf", return_value=(b"%PDF", "pdf-manual", "https://x.com/r.pdf")),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, status="owned", wiki_path=str(tmp_path), edition=None)

    assert captured["slug"] == "root-2018"
    assert captured["edition"] == "2018"


def test_main_slug_uses_edition_override(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.acquire_pdf", return_value=(b"%PDF", "pdf-manual", "https://x.com/r.pdf")),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, status="owned", wiki_path=str(tmp_path), edition="Kickstarter")

    assert captured["slug"] == "root-kickstarter"
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/compiler/test_add_game.py::test_resolve_edition_uses_year_by_default -v
```

Expected: `ImportError` — `_resolve_edition` does not exist yet.

- [ ] **Step 3: Implement edition logic in add_game.py**

Replace the full contents of `scripts/compiler/add_game.py`:

```python
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compiler.bgg_fetcher import fetch_game, _to_slug
from compiler.pdf_fetcher import fetch_pdf
from compiler.pdf_parser import extract_text
from compiler.llm_provider import DeepSeekProvider
from compiler.llm_compiler import compile_game
from compiler.wiki_writer import write_game
from compiler.web_searcher import search_rulebook_pdf
from compiler.bgg_scraper import scrape_bgg_rulebook


def _resolve_edition(game_data: dict, edition_override: str | None) -> str:
    if edition_override:
        return _to_slug(edition_override)
    year = game_data.get("yearpublished", 0)
    return str(year) if year else "unknown"


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


def main(
    bgg_id: int,
    pdf_url: str | None,
    status: str,
    wiki_path: str,
    edition: str | None = None,
) -> None:
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN") or None
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]
    tavily_key = os.environ.get("TAVILY_API_KEY") or None

    provider = DeepSeekProvider(api_key=deepseek_key)

    print(f"Fetching BGG data for game {bgg_id}...")
    game_data = fetch_game(bgg_id, token=bgg_token)

    resolved_edition = _resolve_edition(game_data, edition)
    game_data["slug"] = f"{game_data['slug']}-{resolved_edition}"
    game_data["edition"] = resolved_edition
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
    parser.add_argument("--edition", type=str, default=None,
                        help="Edition label (default: BGG publication year)")
    parser.add_argument("--status", type=str, required=True,
                        choices=["owned", "wishlist", "borrowed", "friend", "played", "archived"])
    parser.add_argument("--wiki_path", type=str, required=True)
    args = parser.parse_args()

    main(
        bgg_id=args.bgg_id,
        pdf_url=args.pdf_url if args.pdf_url else None,
        edition=args.edition if args.edition else None,
        status=args.status,
        wiki_path=args.wiki_path,
    )
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pytest tests/compiler/test_add_game.py -v
```

Expected: all 9 tests PASS (7 existing + 2 new slug tests; `_resolve_edition` tests are 3 more = 12 total).

- [ ] **Step 5: Run full suite**

```bash
pytest tests/compiler/ -v
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/compiler/add_game.py tests/compiler/test_add_game.py
git commit -m "feat: add edition slug to compiler (year default, manual override)"
```

---

### Task 3: Add edition to LLM prompts

**Files:**
- Modify: `scripts/compiler/llm_compiler.py`
- Modify: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: `game_data["edition"]` (str) from Task 2
- Produces: all 6 LLM prompts include edition in the metadata block

- [ ] **Step 1: Write failing test**

Add to `tests/compiler/test_llm_compiler.py` at the end:

```python
def test_compile_game_includes_edition_in_prompts():
    provider = MagicMock()
    provider.generate.return_value = "content"
    game_data_with_edition = {**GAME_DATA, "edition": "2018", "yearpublished": 2018}

    compile_game(game_data_with_edition, rulebook_text=None, provider=provider)

    all_prompts = " ".join(str(call) for call in provider.generate.call_args_list)
    assert "2018" in all_prompts
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pytest tests/compiler/test_llm_compiler.py::test_compile_game_includes_edition_in_prompts -v
```

Expected: FAIL — `AssertionError` because edition is not in prompts yet.

- [ ] **Step 3: Add edition to prompts in llm_compiler.py**

In `scripts/compiler/llm_compiler.py`, in `_prompts()`, update the `meta` block. Find this section:

```python
meta = (
    f"- Players: {game_data['players']}\n"
    f"- Playing time: {game_data['playing_time']} min\n"
    f"- Weight: {game_data['weight']}/5\n"
    f"- BGG Rank: {game_data['rank']}\n"
    f"- Mechanics: {', '.join(game_data['mechanics'])}\n"
    f"- Categories: {', '.join(game_data['categories'])}\n"
    f"- Description: {game_data['description'][:500]}\n"
)
```

Replace with:

```python
meta = (
    f"- Players: {game_data['players']}\n"
    f"- Playing time: {game_data['playing_time']} min\n"
    f"- Weight: {game_data['weight']}/5\n"
    f"- BGG Rank: {game_data['rank']}\n"
    f"- Edition: {game_data.get('edition', 'unknown')}\n"
    f"- Mechanics: {', '.join(game_data['mechanics'])}\n"
    f"- Categories: {', '.join(game_data['categories'])}\n"
    f"- Description: {game_data['description'][:500]}\n"
)
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pytest tests/compiler/test_llm_compiler.py -v
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
git commit -m "feat: include edition in LLM prompts"
```

---

### Task 4: Add edition and yearpublished to wiki frontmatter

**Files:**
- Modify: `scripts/compiler/wiki_writer.py`
- Modify: `tests/compiler/test_wiki_writer.py`

**Interfaces:**
- Consumes: `game_data["edition"]` (str), `game_data["yearpublished"]` (int) from Task 2
- Produces: `index.md` frontmatter includes `edition` and `yearpublished` fields

- [ ] **Step 1: Write failing tests**

Add to `tests/compiler/test_wiki_writer.py` at the end:

```python
GAME_DATA_WITH_EDITION = {
    "id": 237182,
    "name": "Root",
    "slug": "root-2018",
    "edition": "2018",
    "yearpublished": 2018,
    "mechanics": ["Area Control"],
    "players": "2-4",
    "weight": "3.72",
    "rank": "21",
}


def test_build_frontmatter_includes_edition():
    fm = _build_frontmatter(GAME_DATA_WITH_EDITION, "owned", "pdf-manual", None)
    assert 'edition: "2018"' in fm
    assert "yearpublished: 2018" in fm


def test_build_frontmatter_edition_defaults_when_missing():
    fm = _build_frontmatter(GAME_DATA, "owned", "pdf-manual", None)
    assert 'edition: "unknown"' in fm
    assert "yearpublished: 0" in fm
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pytest tests/compiler/test_wiki_writer.py::test_build_frontmatter_includes_edition -v
```

Expected: FAIL — `AssertionError` because `edition` is not in frontmatter yet.

- [ ] **Step 3: Add edition and yearpublished to _build_frontmatter**

In `scripts/compiler/wiki_writer.py`, in `_build_frontmatter`, find the `lines` list. After the `source` line, add `edition` and `yearpublished`:

```python
lines = [
    "---",
    f"bgg_id: {game_data['id']}",
    f'name: "{game_data["name"]}"',
    f"slug: {game_data['slug']}",
    f"status: {status}",
    f"source: {source}",
    f'edition: "{game_data.get("edition", "unknown")}"',
    f"yearpublished: {game_data.get('yearpublished', 0)}",
]
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pytest tests/compiler/test_wiki_writer.py -v
```

Expected: all 8 tests PASS (6 existing + 2 new).

- [ ] **Step 5: Run full suite**

```bash
pytest tests/compiler/ -v
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/compiler/wiki_writer.py tests/compiler/test_wiki_writer.py
git commit -m "feat: add edition and yearpublished to wiki frontmatter"
```

---

### Task 5: Update GitHub Actions workflow

**Files:**
- Modify: `.github/workflows/import-game.yml`

**Interfaces:**
- Consumes: `--edition` arg from Task 2

- [ ] **Step 1: Update the workflow**

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
      edition:
        description: 'Edition label (optional — defaults to BGG publication year)'
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
          EDITION: ${{ inputs.edition }}
          STATUS: ${{ inputs.status }}
        run: |
          ARGS="--bgg_id $BGG_ID --status $STATUS --wiki_path wiki"
          if [ -n "$PDF_URL" ]; then
            ARGS="$ARGS --pdf_url $PDF_URL"
          fi
          if [ -n "$EDITION" ]; then
            ARGS="$ARGS --edition $EDITION"
          fi
          python scripts/compiler/add_game.py $ARGS
```

- [ ] **Step 2: Verify YAML is valid**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/import-game.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/import-game.yml
git commit -m "feat: add edition input to import-game workflow"
git push origin master
```

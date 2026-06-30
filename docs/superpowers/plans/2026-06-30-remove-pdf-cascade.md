# Remove PDF Acquisition Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-step PDF cascade (manual URL → Tavily → BGG scraper) with two explicit paths: user-provided PDF URL, or LLM-only generation with mandatory edition declaration.

**Architecture:** `add_game.py` branches directly on `pdf_url` presence; the `acquire_pdf` function is removed entirely. When no PDF is provided, `--edition` is required and the LLM generates with explicit edition context. `wiki_writer.py` prepends a visible warning callout on all pages when `source == "llm-only"`.

**Tech Stack:** Python 3.13, pytest, PyMuPDF (existing), requests (existing)

## Global Constraints

- Python 3.13
- TDD: write failing tests before implementation in every task
- Run `pytest tests/` from repo root
- No new dependencies
- Commit after each task

---

### Task 1: Rewrite `add_game.py` — two explicit paths + edition validation

**Files:**
- Modify: `scripts/compiler/add_game.py`
- Modify: `tests/compiler/test_add_game.py`

**Interfaces:**
- Consumes: `fetch_pdf(url: str) -> bytes` from `compiler.pdf_fetcher`
- Consumes: `extract_text(pdf_bytes: bytes) -> str` from `compiler.pdf_parser`
- Consumes: `compile_game(game_data, rulebook_text, provider)` from `compiler.llm_compiler`
- Consumes: `write_game(game_data, sections, wiki_path, status, source, pdf_url)` from `compiler.wiki_writer`
- Produces: `main(bgg_id, pdf_url, status, wiki_path, edition=None) -> None`
- Produces: `_resolve_edition(game_data, edition_override) -> str` (unchanged)

- [ ] **Step 1: Replace `tests/compiler/test_add_game.py` with new tests**

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
    "yearpublished": 2018,
}

FULL_SECTIONS = {
    "index": "# Root", "setup": "Setup", "rules": "Rules",
    "teaching": "Teaching", "faq": "FAQ", "glossary": "Glossary",
}


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


# ── main() path tests ────────────────────────────────────────────────────────

def test_main_with_pdf_url_uses_pdf_manual_source(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
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
    assert write_args[5] == "https://example.com/root.pdf"


def test_main_with_llm_only_path_passes_none_rulebook(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])) as mock_compile,
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, edition="2023 Edition",
             status="owned", wiki_path=str(tmp_path))

    compile_args = mock_compile.call_args[0]
    assert compile_args[1] is None  # rulebook_text is None
    write_args = mock_write.call_args[0]
    assert write_args[4] == "llm-only"
    assert write_args[5] is None  # no resolved_url


def test_main_exits_when_no_pdf_url_and_no_edition(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=237182, pdf_url=None, edition=None,
                 status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_slug_includes_edition_from_year(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]
        captured["edition"] = game_data["edition"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path), edition=None)

    assert captured["slug"] == "root-2018"
    assert captured["edition"] == "2018"


def test_main_slug_uses_edition_override(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, status="owned",
             wiki_path=str(tmp_path), edition="Kickstarter")

    assert captured["slug"] == "root-kickstarter"
```

- [ ] **Step 2: Run tests to confirm failures**

```
pytest tests/compiler/test_add_game.py -v
```

Expected: `test_main_with_pdf_url_uses_pdf_manual_source` fails (patches `fetch_pdf` but old code patches `acquire_pdf`); `test_main_exits_when_no_pdf_url_and_no_edition` fails (old code raises RuntimeError via acquire_pdf, not sys.exit); `test_main_with_llm_only_path_passes_none_rulebook` fails (no llm-only path exists).

- [ ] **Step 3: Rewrite `scripts/compiler/add_game.py`**

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


def _resolve_edition(game_data: dict, edition_override: str | None) -> str:
    if edition_override:
        return _to_slug(edition_override)
    year = game_data.get("yearpublished", 0)
    return str(year) if year else "unknown"


def main(
    bgg_id: int,
    pdf_url: str | None,
    status: str,
    wiki_path: str,
    edition: str | None = None,
) -> None:
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN") or None
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]

    provider = DeepSeekProvider(api_key=deepseek_key)

    print(f"Fetching BGG data for game {bgg_id}...")
    game_data = fetch_game(bgg_id, token=bgg_token)

    resolved_edition = _resolve_edition(game_data, edition)
    game_data["slug"] = f"{game_data['slug']}-{resolved_edition}"
    game_data["edition"] = resolved_edition
    print(f"Found: {game_data['name']} ({game_data['slug']})")

    if pdf_url:
        print(f"Downloading PDF from {pdf_url}...")
        pdf_bytes = fetch_pdf(pdf_url)
        rulebook_text = extract_text(pdf_bytes)
        print(f"Extracted {len(rulebook_text)} characters from PDF.")
        source = "pdf-manual"
        resolved_url: str | None = pdf_url
    else:
        if not edition:
            print("Error: --edition is required when --pdf_url is not provided.")
            sys.exit(1)
        rulebook_text = None
        source = "llm-only"
        resolved_url = None

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
                        help="Edition label (required when --pdf_url is not provided)")
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

```
pytest tests/compiler/test_add_game.py -v
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/add_game.py tests/compiler/test_add_game.py
git commit -m "refactor: replace acquire_pdf cascade with two explicit paths in main()"
```

---

### Task 2: Delete dead modules

**Files:**
- Delete: `scripts/compiler/web_searcher.py`
- Delete: `scripts/compiler/bgg_scraper.py`
- Delete: `tests/compiler/test_web_searcher.py`
- Delete: `tests/compiler/test_bgg_scraper.py`

**Interfaces:**
- Consumes: nothing (these are dead code after Task 1)
- Produces: nothing

- [ ] **Step 1: Delete the four files**

```bash
rm scripts/compiler/web_searcher.py
rm scripts/compiler/bgg_scraper.py
rm tests/compiler/test_web_searcher.py
rm tests/compiler/test_bgg_scraper.py
```

- [ ] **Step 2: Run full test suite to confirm nothing is broken**

```
pytest tests/ -v
```

Expected: all tests pass. No import errors — `add_game.py` no longer imports `web_searcher` or `bgg_scraper`.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "chore: delete web_searcher and bgg_scraper (cascade removed)"
```

---

### Task 3: Update `llm_compiler.py` — explicit edition in no-rulebook block

**Files:**
- Modify: `scripts/compiler/llm_compiler.py`
- Modify: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: `game_data["edition"]`, `game_data["name"]` (already available in `_prompts`)
- Produces: `_rulebook_block(rulebook_text: str | None, game_data: dict) -> str` (signature change, internal only)
- `compile_game(game_data, rulebook_text, provider)` signature unchanged

- [ ] **Step 1: Add failing test to `tests/compiler/test_llm_compiler.py`**

Append this test to the existing file:

```python
def test_no_rulebook_block_includes_edition_and_game_name():
    from compiler.llm_compiler import _rulebook_block
    game_data = {**GAME_DATA, "edition": "kickstarter", "name": "Root"}
    result = _rulebook_block(None, game_data)
    assert "kickstarter" in result
    assert "Root" in result
    assert "general knowledge" in result
    assert "uncertainty" in result


def test_rulebook_block_with_text_ignores_edition():
    from compiler.llm_compiler import _rulebook_block
    game_data = {**GAME_DATA, "edition": "kickstarter"}
    result = _rulebook_block("Chapter 1: Setup...", game_data)
    assert "Chapter 1: Setup" in result
    assert "general knowledge" not in result
```

- [ ] **Step 2: Run to confirm failures**

```
pytest tests/compiler/test_llm_compiler.py::test_no_rulebook_block_includes_edition_and_game_name tests/compiler/test_llm_compiler.py::test_rulebook_block_with_text_ignores_edition -v
```

Expected: both fail — `_rulebook_block` currently takes only one argument.

- [ ] **Step 3: Update `scripts/compiler/llm_compiler.py`**

Replace the `_rulebook_block` function and its call in `_prompts`:

```python
def _rulebook_block(rulebook_text: str | None, game_data: dict) -> str:
    if rulebook_text:
        return f"\nRulebook text (authoritative source):\n---\n{rulebook_text}\n---\n"
    edition = game_data.get("edition", "unknown")
    name = game_data["name"]
    return (
        f"\nNo rulebook provided. Generate from general knowledge for the "
        f"**{edition} edition** of \"{name}\". "
        "If rules or components differ between editions, note the uncertainty explicitly.\n"
    )
```

In `_prompts`, update the call (line 18 currently):

```python
rb = _rulebook_block(rulebook_text, game_data)
```

- [ ] **Step 4: Run all llm_compiler tests**

```
pytest tests/compiler/test_llm_compiler.py -v
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
git commit -m "feat: include edition in LLM no-rulebook context block"
```

---

### Task 4: Update `wiki_writer.py` — warning callout for `llm-only` source

**Files:**
- Modify: `scripts/compiler/wiki_writer.py`
- Modify: `tests/compiler/test_wiki_writer.py`

**Interfaces:**
- Consumes: `source: str` and `game_data["edition"]` (already available in `write_game`)
- Produces: `write_game` prepends a callout to all section files when `source == "llm-only"`

- [ ] **Step 1: Add failing tests to `tests/compiler/test_wiki_writer.py`**

Append these tests to the existing file:

```python
GAME_DATA_LLM = {
    "id": 237182,
    "name": "Root",
    "slug": "root-kickstarter",
    "edition": "kickstarter",
    "yearpublished": 2019,
    "mechanics": ["Area Control"],
    "players": "2-4",
    "weight": "3.72",
    "rank": "21",
}


def test_llm_only_warning_appears_in_all_sections(tmp_path):
    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA_LLM, SECTIONS, str(tmp_path), "owned", "llm-only")

    game_dir = tmp_path / "games" / "root-kickstarter"
    for section in ["index", "setup", "rules", "teaching", "faq", "glossary"]:
        content = (game_dir / f"{section}.md").read_text()
        assert "[!WARNING]" in content
        assert "kickstarter" in content
        assert "LLM" in content


def test_pdf_manual_source_has_no_warning(tmp_path):
    with patch("compiler.wiki_writer._git_commit_and_push"):
        write_game(GAME_DATA_WITH_EDITION, SECTIONS, str(tmp_path), "owned", "pdf-manual",
                   "https://example.com/root.pdf")

    game_dir = tmp_path / "games" / "root-2018"
    for section in ["setup", "rules", "teaching", "faq", "glossary"]:
        content = (game_dir / f"{section}.md").read_text()
        assert "[!WARNING]" not in content
```

- [ ] **Step 2: Run to confirm failures**

```
pytest tests/compiler/test_wiki_writer.py::test_llm_only_warning_appears_in_all_sections tests/compiler/test_wiki_writer.py::test_pdf_manual_source_has_no_warning -v
```

Expected: `test_llm_only_warning_appears_in_all_sections` fails — no warning written yet.

- [ ] **Step 3: Update `scripts/compiler/wiki_writer.py`**

Add the `_llm_only_warning` helper and update `write_game`:

```python
import subprocess
from datetime import date
from pathlib import Path


def write_game(
    game_data: dict,
    sections: dict[str, str],
    wiki_path: str,
    status: str,
    source: str,
    pdf_url: str | None = None,
) -> None:
    game_dir = Path(wiki_path) / "games" / game_data["slug"]
    game_dir.mkdir(parents=True, exist_ok=True)

    warning = _llm_only_warning(game_data.get("edition", "unknown")) if source == "llm-only" else ""

    frontmatter = _build_frontmatter(game_data, status, source, pdf_url)
    index_content = sections.get("index", "")
    (game_dir / "index.md").write_text(f"{frontmatter}\n{warning}{index_content}")

    for section in ["setup", "rules", "teaching", "faq", "glossary"]:
        if section in sections:
            (game_dir / f"{section}.md").write_text(f"{warning}{sections[section]}")

    _git_commit_and_push(wiki_path, game_data["slug"], game_data["name"])


def _llm_only_warning(edition: str) -> str:
    return (
        "> [!WARNING]\n"
        "> Contenido generado desde conocimiento general del LLM sin rulebook verificado.\n"
        f"> Edición de referencia: **{edition}**. Puede diferir de otras ediciones.\n\n"
    )


def _build_frontmatter(
    game_data: dict,
    status: str,
    source: str,
    pdf_url: str | None,
) -> str:
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
    if pdf_url is not None:
        lines.append(f'pdf_url: "{pdf_url}"')
    lines += [
        f"players: \"{game_data['players']}\"",
        f"weight: {game_data['weight']}",
        f"rank: {game_data['rank']}",
        "mechanics:",
    ]
    for mechanic in game_data.get("mechanics", []):
        lines.append(f"  - {mechanic}")
    lines += [
        f"imported: {date.today().isoformat()}",
        "---",
    ]
    return "\n".join(lines)


def _git_commit_and_push(wiki_path: str, slug: str, name: str) -> None:
    _git(wiki_path, "add", f"games/{slug}/")
    result = subprocess.run(
        ["git", "-C", wiki_path, "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if result.returncode == 0:
        print(f"No changes to commit for {name} (content unchanged)")
        return
    _git(wiki_path, "commit", "-m", f"feat: add wiki for {name}")
    _git(wiki_path, "push")


def _git(wiki_path: str, *args: str) -> None:
    subprocess.run(["git", "-C", wiki_path, *args], check=True, capture_output=True)
```

- [ ] **Step 4: Run all wiki_writer tests**

```
pytest tests/compiler/test_wiki_writer.py -v
```

Expected: all tests pass. Note: `test_other_sections_have_no_frontmatter` uses `source="ai-generated"` (not `"llm-only"`), so no warning is added and `setup_content == SECTIONS["setup"]` still holds.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/wiki_writer.py tests/compiler/test_wiki_writer.py
git commit -m "feat: prepend LLM-only warning callout to wiki pages when no rulebook"
```

---

### Task 5: Update workflow — remove `TAVILY_API_KEY`

**Files:**
- Modify: `.github/workflows/import-game.yml`

**Interfaces:**
- No code interfaces — workflow change only

- [ ] **Step 1: Edit `.github/workflows/import-game.yml`**

In the `Import game` step, remove the `TAVILY_API_KEY` line from the `env:` block:

```yaml
      - name: Import game
        env:
          GAMECACHE_BGG_TOKEN: ${{ secrets.GAMECACHE_BGG_TOKEN }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          BGG_ID: ${{ inputs.bgg_id }}
          PDF_URL: ${{ inputs.pdf_url }}
          EDITION: ${{ inputs.edition }}
          STATUS: ${{ inputs.status }}
```

Also update the `pdf_url` input description:

```yaml
      pdf_url:
        description: 'Direct URL to the rulebook PDF for your physical edition (if omitted, --edition is required and content is generated from LLM knowledge)'
        required: false
        type: string
        default: ''
```

- [ ] **Step 2: Run full test suite one final time**

```
pytest tests/ -v
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/import-game.yml
git commit -m "chore: remove TAVILY_API_KEY from import-game workflow"
```

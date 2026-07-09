# Obsidian Mechanics Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have the compiler create/update `/mechanics/*.md` notes in the wiki vault so every mechanic a game uses has a real note to link to — making mechanics browsable and visible in Obsidian's native graph view.

**Architecture:** `add_game.py` checks, for each mechanic on the game being imported, whether `/mechanics/{name}.md` already exists in the wiki. For mechanics without a page yet, it generates a short description via the existing `DeepSeekProvider` (one call per unique mechanic, only the first time it's ever seen). It then calls `sync_mechanic_pages`, which creates new pages or appends an idempotent backlink to existing ones — all written to disk *before* `write_game` runs, so the mechanics files land in the same git commit as the game import.

**Tech Stack:** Python 3.13, same stack as the existing compiler — no new dependencies.

## Global Constraints

- All code changes are under `scripts/compiler/` and `tests/compiler/` — no changes to `worker/`, KV, or chat prompts.
- Run tests with `source venv/bin/activate && python -m pytest tests/compiler/ -v` from the repo root after every task.
- This plan builds on top of the compiler-fidelity plan (`docs/superpowers/plans/2026-07-09-compiler-fidelity.md`) — `add_game.py` and `llm_compiler.py` are assumed to already be in their post-that-plan state (`GeminiProvider` exists, `compile_game` takes `pdf_bytes`/`deepseek_provider`/`gemini_provider`). If that plan hasn't been executed yet, run it first.
- Existing mechanic pages are never overwritten — only appended to (manual edits in Obsidian must be preserved).
- A failed mechanic-description call must not abort the game import — it only skips that mechanic's page for this run (per `docs/superpowers/specs/2026-07-09-obsidian-mechanics-pages-design.md`).
- No `graph_index.json`, no Worker changes, no KV changes — explicitly out of scope per the design spec.

---

## File Map

| File | Change |
|------|--------|
| `scripts/compiler/llm_compiler.py` | Add `generate_mechanic_description(name, provider) -> str` |
| `scripts/compiler/wiki_writer.py` | Add `mechanic_page_exists`, `sync_mechanic_pages`; stage `mechanics/` in `_git_commit_and_push` when present |
| `scripts/compiler/add_game.py` | Orchestrate mechanic-page sync before `write_game` |
| `tests/compiler/test_llm_compiler.py` | Add `generate_mechanic_description` test |
| `tests/compiler/test_wiki_writer.py` | Add tests for `mechanic_page_exists`, `sync_mechanic_pages`, and the git-add-mechanics behavior |
| `tests/compiler/test_add_game.py` | Add `sync_mechanic_pages` patch to existing tests; add 2 new orchestration tests |

---

## Task 1: Generate mechanic descriptions

**Files:**
- Modify: `scripts/compiler/llm_compiler.py`
- Test: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: `LLMProvider.generate(system, prompt) -> str` (existing)
- Produces: `generate_mechanic_description(name: str, provider: LLMProvider) -> str`. Used by `add_game.py` in Task 3.

---

- [ ] **Step 1: Write the failing test**

Append to `tests/compiler/test_llm_compiler.py`:

```python
def test_generate_mechanic_description_returns_text():
    from compiler.llm_compiler import generate_mechanic_description, SYSTEM
    provider = MagicMock()
    provider.generate.return_value = "A mechanic about area control."

    result = generate_mechanic_description("Area Control", provider)

    assert result == "A mechanic about area control."
    call_kwargs = provider.generate.call_args.kwargs
    assert "Area Control" in call_kwargs["prompt"]
    assert call_kwargs["system"] == SYSTEM
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_compiler.py -k generate_mechanic_description -v
```

Expected: FAIL with `ImportError: cannot import name 'generate_mechanic_description'`.

- [ ] **Step 3: Implement `generate_mechanic_description`**

Append to the end of `scripts/compiler/llm_compiler.py`:

```python


def generate_mechanic_description(name: str, provider: LLMProvider) -> str:
    prompt = (
        f"Describe the board game mechanic \"{name}\" in 1-2 sentences, for a personal "
        "Obsidian wiki. No heading, no frontmatter — plain prose only."
    )
    return provider.generate(system=SYSTEM, prompt=prompt)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_llm_compiler.py -k generate_mechanic_description -v
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
git commit -m "feat: add mechanic description generation"
```

---

## Task 2: Sync mechanic pages into the wiki

**Files:**
- Modify: `scripts/compiler/wiki_writer.py`
- Test: `tests/compiler/test_wiki_writer.py`

**Interfaces:**
- Produces:
  - `mechanic_page_exists(wiki_path: str, mechanic: str) -> bool`
  - `sync_mechanic_pages(wiki_path: str, game_data: dict, descriptions: dict[str, str]) -> None`
  - `_git_commit_and_push` now also stages `mechanics/` when that directory exists.
  - Used by `add_game.py` in Task 3.

---

- [ ] **Step 1: Write the failing tests**

Append to `tests/compiler/test_wiki_writer.py`:

```python
def test_mechanic_page_exists_false_when_missing(tmp_path):
    from compiler.wiki_writer import mechanic_page_exists
    assert mechanic_page_exists(str(tmp_path), "Area Control") is False


def test_mechanic_page_exists_true_when_present(tmp_path):
    from compiler.wiki_writer import mechanic_page_exists
    mech_dir = tmp_path / "mechanics"
    mech_dir.mkdir()
    (mech_dir / "Area Control.md").write_text("# Area Control\n")
    assert mechanic_page_exists(str(tmp_path), "Area Control") is True


def test_sync_mechanic_pages_creates_new_page(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control"]}

    sync_mechanic_pages(str(tmp_path), game_data, {"Area Control": "A mechanic about map control."})

    content = (tmp_path / "mechanics" / "Area Control.md").read_text()
    assert content.startswith("# Area Control")
    assert "A mechanic about map control." in content
    assert "[[root-2018]] — Root" in content


def test_sync_mechanic_pages_appends_backlink_to_existing_page(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    mech_dir = tmp_path / "mechanics"
    mech_dir.mkdir()
    (mech_dir / "Area Control.md").write_text(
        "# Area Control\n\nDescription.\n\n## Juegos en tu catálogo que la usan:\n* [[scythe-2016]] — Scythe\n"
    )
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control"]}

    sync_mechanic_pages(str(tmp_path), game_data, {})

    content = (mech_dir / "Area Control.md").read_text()
    assert "[[scythe-2016]] — Scythe" in content
    assert "[[root-2018]] — Root" in content


def test_sync_mechanic_pages_does_not_duplicate_backlink(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    mech_dir = tmp_path / "mechanics"
    mech_dir.mkdir()
    (mech_dir / "Area Control.md").write_text(
        "# Area Control\n\nDescription.\n\n## Juegos en tu catálogo que la usan:\n* [[root-2018]] — Root\n"
    )
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control"]}

    sync_mechanic_pages(str(tmp_path), game_data, {})

    content = (mech_dir / "Area Control.md").read_text()
    assert content.count("[[root-2018]]") == 1


def test_sync_mechanic_pages_handles_multiple_mechanics(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control", "Hand Management"]}

    sync_mechanic_pages(
        str(tmp_path), game_data,
        {"Area Control": "Desc A.", "Hand Management": "Desc B."},
    )

    assert (tmp_path / "mechanics" / "Area Control.md").exists()
    assert (tmp_path / "mechanics" / "Hand Management.md").exists()


def test_sync_mechanic_pages_skips_when_no_description_available(tmp_path):
    from compiler.wiki_writer import sync_mechanic_pages
    game_data = {"slug": "root-2018", "name": "Root", "mechanics": ["Area Control"]}

    sync_mechanic_pages(str(tmp_path), game_data, {})  # no description generated for it

    assert not (tmp_path / "mechanics" / "Area Control.md").exists()


def test_git_commit_and_push_adds_mechanics_dir_when_present(tmp_path):
    from compiler.wiki_writer import _git_commit_and_push
    (tmp_path / "games" / "root").mkdir(parents=True)
    (tmp_path / "mechanics").mkdir()

    with patch("compiler.wiki_writer._git") as mock_git:
        _git_commit_and_push(str(tmp_path), "root", "Root")

    added_paths = [c.args[2] for c in mock_git.call_args_list if c.args[1] == "add"]
    assert "mechanics/" in added_paths


def test_git_commit_and_push_skips_mechanics_dir_when_absent(tmp_path):
    from compiler.wiki_writer import _git_commit_and_push
    (tmp_path / "games" / "root").mkdir(parents=True)

    with patch("compiler.wiki_writer._git") as mock_git:
        _git_commit_and_push(str(tmp_path), "root", "Root")

    added_paths = [c.args[2] for c in mock_git.call_args_list if c.args[1] == "add"]
    assert "mechanics/" not in added_paths
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_wiki_writer.py -v
```

Expected: the 9 new tests FAIL — the first 6 with `ImportError`, the last 2 with an `AssertionError` (empty `added_paths`, since `mechanics/` isn't staged yet) or a real `git` subprocess error (harmless — `tmp_path` isn't a git repo and the un-mocked `diff --cached --quiet` check exits non-zero either way, so execution still reaches the mocked `_git` calls). All existing tests still pass.

- [ ] **Step 3: Implement `mechanic_page_exists` and `sync_mechanic_pages`, and update `_git_commit_and_push`**

Append to the end of `scripts/compiler/wiki_writer.py`:

```python


def mechanic_page_exists(wiki_path: str, mechanic: str) -> bool:
    return (Path(wiki_path) / "mechanics" / f"{mechanic}.md").exists()


def sync_mechanic_pages(
    wiki_path: str,
    game_data: dict,
    descriptions: dict[str, str],
) -> None:
    for mechanic in game_data.get("mechanics", []):
        page_path = Path(wiki_path) / "mechanics" / f"{mechanic}.md"
        entry = f"* [[{game_data['slug']}]] — {game_data['name']}"
        if page_path.exists():
            content = page_path.read_text()
            if entry in content:
                continue
            page_path.write_text(content.rstrip() + f"\n{entry}\n")
        elif mechanic in descriptions:
            page_path.parent.mkdir(parents=True, exist_ok=True)
            page_path.write_text(
                f"# {mechanic}\n\n{descriptions[mechanic]}\n\n"
                f"## Juegos en tu catálogo que la usan:\n{entry}\n"
            )
        # else: no page yet and no description available (generation failed) — skip this run
```

Now update `_git_commit_and_push`. Replace:

```python
def _git_commit_and_push(
    wiki_path: str,
    slug: str,
    name: str,
    base_game_slug: str | None = None,
) -> None:
    _git(wiki_path, "add", f"games/{slug}/")
    if base_game_slug:
        _git(wiki_path, "add", f"games/{base_game_slug}/index.md")
    result = subprocess.run(
        ["git", "-C", wiki_path, "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if result.returncode == 0:
        print(f"No changes to commit for {name} (content unchanged)")
        return
    _git(wiki_path, "commit", "-m", f"feat: add wiki for {name}")
    _git(wiki_path, "push")
```

with:

```python
def _git_commit_and_push(
    wiki_path: str,
    slug: str,
    name: str,
    base_game_slug: str | None = None,
) -> None:
    _git(wiki_path, "add", f"games/{slug}/")
    if base_game_slug:
        _git(wiki_path, "add", f"games/{base_game_slug}/index.md")
    if (Path(wiki_path) / "mechanics").exists():
        _git(wiki_path, "add", "mechanics/")
    result = subprocess.run(
        ["git", "-C", wiki_path, "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if result.returncode == 0:
        print(f"No changes to commit for {name} (content unchanged)")
        return
    _git(wiki_path, "commit", "-m", f"feat: add wiki for {name}")
    _git(wiki_path, "push")
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_wiki_writer.py -v
```

Expected: all tests pass (original + 9 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/wiki_writer.py tests/compiler/test_wiki_writer.py
git commit -m "feat: sync mechanic pages into the wiki vault"
```

---

## Task 3: Wire mechanic-page sync into add_game.py

**Files:**
- Modify: `scripts/compiler/add_game.py`
- Modify: `tests/compiler/test_add_game.py`

**Interfaces:**
- Consumes: `generate_mechanic_description` (Task 1), `mechanic_page_exists`/`sync_mechanic_pages` (Task 2)

---

- [ ] **Step 1: Update the imports**

In `scripts/compiler/add_game.py`, replace:

```python
from compiler.llm_provider import DeepSeekProvider, GeminiProvider
from compiler.llm_compiler import compile_game
from compiler.wiki_writer import write_game
```

with:

```python
from compiler.llm_provider import DeepSeekProvider, GeminiProvider
from compiler.llm_compiler import compile_game, generate_mechanic_description
from compiler.wiki_writer import write_game, mechanic_page_exists, sync_mechanic_pages
```

- [ ] **Step 2: Insert the mechanic-sync step before `write_game`**

Replace:

```python
    print(f"Writing wiki files to {wiki_path}/games/{game_data['slug']}/...")
    write_game(game_data, sections, wiki_path, status, source, resolved_url)
```

with:

```python
    new_mechanics = [
        m for m in game_data.get("mechanics", []) if not mechanic_page_exists(wiki_path, m)
    ]
    descriptions = {}
    if new_mechanics:
        print(f"Generating descriptions for {len(new_mechanics)} new mechanic(s)...")
    for mechanic in new_mechanics:
        try:
            descriptions[mechanic] = generate_mechanic_description(mechanic, provider)
        except Exception as e:
            print(f"Warning: failed to generate description for mechanic '{mechanic}': {e}")
    sync_mechanic_pages(wiki_path, game_data, descriptions)

    print(f"Writing wiki files to {wiki_path}/games/{game_data['slug']}/...")
    write_game(game_data, sections, wiki_path, status, source, resolved_url)
```

- [ ] **Step 3: Update `test_add_game.py`**

Replace the entire contents of `tests/compiler/test_add_game.py` with:

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
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.sync_mechanic_pages"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": "bgg-token"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path))

    write_args = mock_write.call_args[0]
    assert write_args[4] == "pdf-manual"
    assert write_args[5] == "https://example.com/root.pdf"


def test_main_with_pdf_url_passes_pdf_bytes_to_compile_game(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF-fake-bytes"),
        patch("compiler.add_game.extract_text", return_value="Rules text"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.sync_mechanic_pages"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])) as mock_compile,
        patch("compiler.add_game.write_game"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key", "GAMECACHE_BGG_TOKEN": "bgg-token"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path))

    compile_args = mock_compile.call_args[0]
    assert compile_args[2] == b"%PDF-fake-bytes"


def test_main_with_llm_only_path_passes_none_rulebook(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.sync_mechanic_pages"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])) as mock_compile,
        patch("compiler.add_game.write_game") as mock_write,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, edition="2023 Edition",
             status="owned", wiki_path=str(tmp_path))

    compile_args = mock_compile.call_args[0]
    assert compile_args[1] is None  # rulebook_text is None
    assert compile_args[2] is None  # pdf_bytes is None
    write_args = mock_write.call_args[0]
    assert write_args[4] == "llm-only"
    assert write_args[5] is None  # no resolved_url


def test_main_exits_when_no_pdf_url_and_no_edition(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key"}),
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
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.sync_mechanic_pages"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
             status="owned", wiki_path=str(tmp_path), edition=None)

    assert captured["slug"] == "root-2018"
    assert captured["edition"] == "2018"


def test_main_exits_when_pdf_extracts_no_text(tmp_path):
    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value=""),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key", "GEMINI_API_KEY": "fake-key"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=237182, pdf_url="https://example.com/root.pdf",
                 status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_slug_uses_edition_override(tmp_path):
    captured = {}
    def capture_write(game_data, *args, **kwargs):
        captured["slug"] = game_data["slug"]

    with (
        patch("compiler.add_game.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.sync_mechanic_pages"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.write_game", side_effect=capture_write),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, status="owned",
             wiki_path=str(tmp_path), edition="Kickstarter")

    assert captured["slug"] == "root-kickstarter"


# ── find_base_game_in_wiki unit tests ────────────────────────────────────────

def test_find_base_game_returns_slug_and_name(tmp_path):
    from compiler.add_game import find_base_game_in_wiki
    game_dir = tmp_path / "games" / "pandemic-2008"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 30549\nname: "Pandemic"\nslug: pandemic-2008\n---\n\nContent.'
    )
    result = find_base_game_in_wiki(str(tmp_path), 30549)
    assert result == {"slug": "pandemic-2008", "name": "Pandemic"}


def test_find_base_game_returns_none_when_not_found(tmp_path):
    from compiler.add_game import find_base_game_in_wiki
    game_dir = tmp_path / "games" / "root-2018"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 237182\nname: "Root"\nslug: root-2018\n---\n'
    )
    result = find_base_game_in_wiki(str(tmp_path), 30549)
    assert result is None


def test_find_base_game_ignores_partial_id_match(tmp_path):
    from compiler.add_game import find_base_game_in_wiki
    game_dir = tmp_path / "games" / "pandemic-2008"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 305490\nname: "Other"\nslug: pandemic-2008\n---\n'
    )
    result = find_base_game_in_wiki(str(tmp_path), 30549)
    assert result is None


# ── expansion main() path tests ──────────────────────────────────────────────

EXPANSION_GAME_DATA = {
    "id": 161936, "name": "Pandemic: In the Lab", "slug": "pandemic-in-the-lab",
    "description": "Expansion.", "mechanics": ["Cooperative Game"],
    "categories": ["Expansion"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "2.5", "rank": "Not Ranked", "playing_time": "45",
    "yearpublished": 2014,
    "is_expansion": True, "base_game_id": 30549,
}


def test_main_expansion_exits_when_base_game_not_in_wiki(tmp_path):
    (tmp_path / "games").mkdir()
    with (
        patch("compiler.add_game.fetch_game", return_value=EXPANSION_GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        with pytest.raises(SystemExit) as exc:
            main(bgg_id=161936, pdf_url="https://example.com/exp.pdf",
                 status="owned", wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_expansion_sets_base_game_fields_in_game_data(tmp_path):
    game_dir = tmp_path / "games" / "pandemic-2008"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        '---\nbgg_id: 30549\nname: "Pandemic"\nslug: pandemic-2008\n---\n'
    )
    captured = {}
    def capture_compile(game_data, *args, **kwargs):
        captured.update(game_data)
        return (FULL_SECTIONS, [])

    with (
        patch("compiler.add_game.fetch_game", return_value=EXPANSION_GAME_DATA.copy()),
        patch("compiler.add_game.fetch_pdf", return_value=b"%PDF"),
        patch("compiler.add_game.extract_text", return_value="Rules"),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.sync_mechanic_pages"),
        patch("compiler.add_game.compile_game", side_effect=capture_compile),
        patch("compiler.add_game.write_game"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=161936, pdf_url="https://example.com/exp.pdf",
             status="owned", wiki_path=str(tmp_path))

    assert captured["base_game_slug"] == "pandemic-2008"
    assert captured["base_game_name"] == "Pandemic"


# ── mechanic-page orchestration tests ────────────────────────────────────────

def test_main_generates_description_only_for_new_mechanics(tmp_path):
    (tmp_path / "mechanics").mkdir()
    (tmp_path / "mechanics" / "Area Control.md").write_text("# Area Control\n\nDesc.\n")
    game_data = {**GAME_DATA, "mechanics": ["Area Control", "Hand Management"]}

    with (
        patch("compiler.add_game.fetch_game", return_value=game_data.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.generate_mechanic_description", return_value="A mechanic.") as mock_desc,
        patch("compiler.add_game.sync_mechanic_pages") as mock_sync,
        patch("compiler.add_game.write_game"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, edition="2018",
             status="owned", wiki_path=str(tmp_path))

    mock_desc.assert_called_once()
    assert mock_desc.call_args[0][0] == "Hand Management"
    sync_args = mock_sync.call_args[0]
    assert sync_args[2] == {"Hand Management": "A mechanic."}


def test_main_skips_description_generation_when_all_mechanics_exist(tmp_path):
    (tmp_path / "mechanics").mkdir()
    (tmp_path / "mechanics" / "Area Control.md").write_text("# Area Control\n\nDesc.\n")
    game_data = {**GAME_DATA, "mechanics": ["Area Control"]}

    with (
        patch("compiler.add_game.fetch_game", return_value=game_data.copy()),
        patch("compiler.add_game.DeepSeekProvider"),
        patch("compiler.add_game.GeminiProvider"),
        patch("compiler.add_game.compile_game", return_value=(FULL_SECTIONS, [])),
        patch("compiler.add_game.generate_mechanic_description") as mock_desc,
        patch("compiler.add_game.sync_mechanic_pages") as mock_sync,
        patch("compiler.add_game.write_game"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=237182, pdf_url=None, edition="2018",
             status="owned", wiki_path=str(tmp_path))

    mock_desc.assert_not_called()
    sync_args = mock_sync.call_args[0]
    assert sync_args[2] == {}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source venv/bin/activate && python -m pytest tests/compiler/test_add_game.py -v
```

Expected: all tests pass (13 from the compiler-fidelity plan + 2 new mechanic-orchestration tests = 15).

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/add_game.py tests/compiler/test_add_game.py
git commit -m "feat: wire mechanic page sync into add_game orchestration"
```

---

## Task 4: Full verification

**Files:** none (verification only)

---

- [ ] **Step 1: Run the entire compiler test suite**

```bash
source venv/bin/activate && python -m pytest tests/compiler/ -v
```

Expected: all tests pass — no regressions in game-file writing, expansion linking, or the compiler-fidelity behavior from the prior plan.

- [ ] **Step 2: Manual sanity check on a real (throwaway) wiki path**

```bash
mkdir -p /tmp/wiki-sanity-check/mechanics
python3 -c "
import sys
sys.path.insert(0, 'scripts')
from compiler.wiki_writer import sync_mechanic_pages
game_data = {'slug': 'root-2018', 'name': 'Root', 'mechanics': ['Area Control', 'Hand Management']}
sync_mechanic_pages('/tmp/wiki-sanity-check', game_data, {
    'Area Control': 'Players compete for influence over regions of the map.',
    'Hand Management': 'Players manage a hand of cards, choosing which to play and when.',
})
"
cat "/tmp/wiki-sanity-check/mechanics/Area Control.md"
cat "/tmp/wiki-sanity-check/mechanics/Hand Management.md"
rm -rf /tmp/wiki-sanity-check
```

Expected: both files print with a `#` heading, the description, and a `## Juegos en tu catálogo que la usan:` section listing `[[root-2018]] — Root`.

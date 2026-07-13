# Selective Wiki-Section Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a way to regenerate just the requested sections (e.g. `teaching`) of an already-imported game's wiki entry, instead of `add_game.py`'s current all-6-sections-every-time behavior.

**Architecture:** Three additive changes, each independently testable. (1) `compile_game()` in `scripts/compiler/llm_compiler.py` gains an optional `only_sections` filter — defaults to `None`, preserving today's behavior for every existing caller. (2) `wiki_writer.py` gains `update_sections()`, a sibling of `write_game()` that writes only the given section files to an *existing* game directory and commits/pushes only those files. (3) A new script, `scripts/compiler/refresh_sections.py`, ties them together: reads the existing game's frontmatter (no CLI flags for edition/pdf_url needed — they're already on disk), re-fetches live BGG metadata, regenerates only the requested sections, and writes them.

**Tech Stack:** Python, `pytest`, same compiler package (`scripts/compiler/`) as `add_game.py`/`bulk_import.py`.

**Full design context:** `docs/superpowers/specs/2026-07-12-selective-section-refresh-design.md`

## Global Constraints

- `compile_game()`'s new `only_sections` parameter must default to `None` and change *zero* behavior for existing callers (`add_game.py`, `bulk_import.py`, existing tests) that don't pass it.
- `update_sections()` must never touch `index.md` — only the section files it's asked to write.
- `update_sections()`'s git commit must be scoped to exactly the files it wrote — not the whole `games/<slug>/` directory (unlike `write_game()`'s `_git_commit_and_push`).
- `refresh_sections.py` never recomputes `slug` or `edition` from fresh BGG data — both come from the existing wiki entry's frontmatter, verbatim.
- No bulk-refresh orchestration (looping over many slugs) — this script operates on one `--slug` per invocation, per the spec's explicit scope decision.

---

### Task 1: `compile_game()` gains an `only_sections` filter

**Files:**
- Modify: `scripts/compiler/llm_compiler.py:283-314`
- Test: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `compile_game(game_data, rulebook_text, pdf_bytes, deepseek_provider, gemini_provider, only_sections: set[str] | None = None) -> tuple[dict[str, str], list[str]]`. Task 3 calls this with `only_sections={"teaching"}` (or whatever `--sections` resolves to).

- [ ] **Step 1: Write the failing test**

Add to `tests/compiler/test_llm_compiler.py`, directly after `test_compile_game_returns_six_sections` (after line 34):

```python
def test_compile_game_only_sections_generates_requested_subset():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "# Teaching content"
    gemini_provider = MagicMock()

    sections, failures = compile_game(
        GAME_DATA, rulebook_text=None, pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
        only_sections={"teaching"},
    )

    assert set(sections.keys()) == {"teaching"}
    assert failures == []
    assert deepseek_provider.generate.call_count == 1
    gemini_provider.generate.assert_not_called()
    gemini_provider.generate_multimodal.assert_not_called()


def test_compile_game_only_sections_can_include_rules_and_setup():
    deepseek_provider = MagicMock()
    deepseek_provider.generate.return_value = "content"
    gemini_provider = MagicMock()

    sections, failures = compile_game(
        GAME_DATA, rulebook_text=None, pdf_bytes=None,
        deepseek_provider=deepseek_provider, gemini_provider=gemini_provider,
        only_sections={"rules", "setup"},
    )

    assert set(sections.keys()) == {"rules", "setup"}
    assert failures == []
    # No pdf_bytes provided, so both fall back to the deepseek text path (see
    # _compile_rules/_compile_setup) — two calls, one per requested section.
    assert deepseek_provider.generate.call_count == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/test_llm_compiler.py::test_compile_game_only_sections_generates_requested_subset -v`
Expected: FAIL with `TypeError: compile_game() got an unexpected keyword argument 'only_sections'`.

- [ ] **Step 3: Add the `only_sections` parameter**

In `scripts/compiler/llm_compiler.py`, replace the `compile_game` function (lines 283-314):

```python
def compile_game(
    game_data: dict,
    rulebook_text: str | None,
    pdf_bytes: bytes | None,
    deepseek_provider: LLMProvider,
    gemini_provider: LLMProvider,
    only_sections: set[str] | None = None,
) -> tuple[dict[str, str], list[str]]:
    prompts = _prompts(game_data, rulebook_text)
    sections: dict[str, str] = {}
    failures: list[str] = []

    for section_name in SECTION_ORDER:
        if only_sections is not None and section_name not in only_sections:
            continue
        if section_name == "rules":
            _compile_rules(
                game_data, rulebook_text, pdf_bytes, prompts["rules"],
                deepseek_provider, gemini_provider, sections, failures,
            )
        elif section_name == "setup":
            _compile_setup(
                pdf_bytes, prompts["setup"], deepseek_provider, gemini_provider,
                sections, failures,
            )
        else:
            try:
                sections[section_name] = deepseek_provider.generate(
                    system=SYSTEM, prompt=prompts[section_name]
                )
            except Exception as e:
                print(f"Warning: failed to generate '{section_name}': {e}")
                failures.append(section_name)

    return sections, failures
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/test_llm_compiler.py -v`
Expected: PASS — both new tests pass, and every pre-existing test in the file still passes unchanged, including `test_compile_game_returns_six_sections` (which doesn't pass `only_sections` at all) — this is the backward-compatibility proof for the Global Constraint above.

- [ ] **Step 5: Commit**

```bash
cd /home/carlos-ardila/Documents/gitprojects/mybgg
git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
git commit -m "$(cat <<'EOF'
feat: let compile_game() regenerate a subset of sections

Adds an only_sections filter, defaulting to None (all six sections,
unchanged behavior for every existing caller) — needed so a future
refresh tool can regenerate e.g. just "teaching" without touching the
other five sections or spending 5 extra LLM calls per game.
EOF
)"
```

---

### Task 2: `wiki_writer.py` gains `update_sections()`

**Files:**
- Modify: `scripts/compiler/wiki_writer.py` (insert after `write_game`, i.e. after line 47, before `def _llm_only_warning` at line 50)
- Test: `tests/compiler/test_wiki_writer.py`

**Interfaces:**
- Consumes: `_git(wiki_path, *args)` (existing, line 144-145) and `_llm_only_warning(edition)` (existing, line 50-55) — both reused unchanged.
- Produces: `update_sections(wiki_path: str, slug: str, sections: dict[str, str], game_name: str, warning: str = "") -> None`, raises `FileNotFoundError` if `games/<slug>/` doesn't exist. Task 3 calls this after `compile_game(..., only_sections=...)`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/compiler/test_wiki_writer.py`, at the end of the file (after line 381):

```python
def test_update_sections_writes_only_requested_files(tmp_path):
    from compiler.wiki_writer import update_sections
    game_dir = tmp_path / "games" / "root"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text("---\nbgg_id: 237182\n---\n\n# Root\n")

    with patch("compiler.wiki_writer._git"):
        update_sections(str(tmp_path), "root", {"teaching": "New teaching content."}, "Root")

    assert (game_dir / "teaching.md").read_text() == "New teaching content."
    assert not (game_dir / "faq.md").exists()


def test_update_sections_does_not_touch_index(tmp_path):
    from compiler.wiki_writer import update_sections
    game_dir = tmp_path / "games" / "root"
    game_dir.mkdir(parents=True)
    original_index = "---\nbgg_id: 237182\n---\n\n# Root\n"
    (game_dir / "index.md").write_text(original_index)

    with patch("compiler.wiki_writer._git"):
        update_sections(str(tmp_path), "root", {"teaching": "New teaching content."}, "Root")

    assert (game_dir / "index.md").read_text() == original_index


def test_update_sections_applies_warning_prefix(tmp_path):
    from compiler.wiki_writer import update_sections, _llm_only_warning
    game_dir = tmp_path / "games" / "root"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text("---\nbgg_id: 237182\n---\n\n# Root\n")
    warning = _llm_only_warning("2018")

    with patch("compiler.wiki_writer._git"):
        update_sections(str(tmp_path), "root", {"teaching": "Body."}, "Root", warning=warning)

    content = (game_dir / "teaching.md").read_text()
    assert content.startswith(warning)
    assert content.endswith("Body.")


def test_update_sections_raises_when_game_dir_missing(tmp_path):
    from compiler.wiki_writer import update_sections
    with pytest.raises(FileNotFoundError):
        update_sections(str(tmp_path), "nonexistent-slug", {"teaching": "x"}, "Nonexistent")


def test_update_sections_commits_only_touched_files(tmp_path):
    from compiler.wiki_writer import update_sections
    game_dir = tmp_path / "games" / "root"
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text("---\nbgg_id: 237182\n---\n\n# Root\n")

    with patch("compiler.wiki_writer._git") as mock_git:
        update_sections(str(tmp_path), "root", {"teaching": "New content."}, "Root")

    add_calls = [c for c in mock_git.call_args_list if c.args[1] == "add"]
    assert len(add_calls) == 1
    assert add_calls[0].args[2] == str(game_dir / "teaching.md")

    commit_calls = [c for c in mock_git.call_args_list if c.args[1] == "commit"]
    assert len(commit_calls) == 1
    assert "teaching" in commit_calls[0].args[3]
    assert "Root" in commit_calls[0].args[3]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/test_wiki_writer.py -k update_sections -v`
Expected: FAIL — `ImportError: cannot import name 'update_sections' from 'compiler.wiki_writer'` (all 5 new tests fail on collection).

- [ ] **Step 3: Implement `update_sections`**

In `scripts/compiler/wiki_writer.py`, insert this function after `write_game` ends (after line 47, before the blank line and `def _llm_only_warning` at line 50):

```python
def update_sections(
    wiki_path: str,
    slug: str,
    sections: dict[str, str],
    game_name: str,
    warning: str = "",
) -> None:
    game_dir = Path(wiki_path) / "games" / slug
    if not game_dir.exists():
        raise FileNotFoundError(f"No existing wiki entry for slug '{slug}' at {game_dir}")

    for section, content in sections.items():
        (game_dir / f"{section}.md").write_text(f"{warning}{content}")

    section_names = ", ".join(sorted(sections))
    paths = [str(game_dir / f"{s}.md") for s in sections]
    _git(wiki_path, "add", *paths)
    result = subprocess.run(
        ["git", "-C", wiki_path, "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if result.returncode == 0:
        print(f"No changes to commit for {game_name} ({section_names})")
        return
    _git(wiki_path, "commit", "-m", f"refresh: regenerate {section_names} for {game_name}")
    _git(wiki_path, "push")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/test_wiki_writer.py -v`
Expected: PASS — all 5 new tests plus every pre-existing test in the file (`write_game`, `_build_frontmatter`, `_update_base_game_expansions`, mechanic-page tests) still pass unchanged.

- [ ] **Step 5: Commit**

```bash
cd /home/carlos-ardila/Documents/gitprojects/mybgg
git add scripts/compiler/wiki_writer.py tests/compiler/test_wiki_writer.py
git commit -m "$(cat <<'EOF'
feat: add update_sections() for partial wiki-entry refreshes

Sibling of write_game() that writes only the given section files to
an already-existing game directory, and commits only those files —
never touches index.md or the other sections.
EOF
)"
```

---

### Task 3: `scripts/compiler/refresh_sections.py`

**Files:**
- Create: `scripts/compiler/refresh_sections.py`
- Test: `tests/compiler/test_refresh_sections.py`

**Interfaces:**
- Consumes: `compile_game(..., only_sections=...)` (Task 1), `update_sections(...)` and `_llm_only_warning(...)` (Task 2), plus existing unchanged: `fetch_game(bgg_id, token=...)` from `compiler.bgg_fetcher`, `fetch_pdf(pdf_url)` from `compiler.pdf_fetcher`, `extract_text(pdf_bytes)` from `compiler.pdf_parser`, `DeepSeekProvider`/`GeminiProvider` from `compiler.llm_provider`, `SECTION_ORDER` from `compiler.llm_compiler`.
- Produces: `main(slug: str, sections: set[str], wiki_path: str) -> None` — CLI entry point, no other module depends on it.

- [ ] **Step 1: Write the failing tests**

Create `tests/compiler/test_refresh_sections.py`:

```python
from unittest.mock import patch
import pytest


GAME_DATA = {
    "id": 237182, "name": "Root", "slug": "root",
    "description": "A game.", "mechanics": ["Area Control"],
    "categories": ["Animals"], "players": "2-4",
    "min_players": 2, "max_players": 4,
    "weight": "3.72", "rank": "21", "playing_time": "60",
    "yearpublished": 2018,
}

TEACHING_ONLY = {"teaching": "Nuevo contenido de teaching."}


def _write_index(tmp_path, slug, extra_frontmatter=""):
    game_dir = tmp_path / "games" / slug
    game_dir.mkdir(parents=True)
    (game_dir / "index.md").write_text(
        f'---\nbgg_id: 237182\nname: "Root"\nslug: {slug}\nedition: "2018"\n'
        f"{extra_frontmatter}---\n\n# Root\n"
    )
    return game_dir


# ── frontmatter reading ──────────────────────────────────────────────────────

def test_read_existing_game_extracts_bgg_id_and_edition(tmp_path):
    from compiler.refresh_sections import _read_existing_game
    _write_index(tmp_path, "root")
    result = _read_existing_game(str(tmp_path), "root")
    assert result["bgg_id"] == 237182
    assert result["edition"] == "2018"
    assert result["pdf_url"] is None
    assert result["base_game_slug"] is None


def test_read_existing_game_extracts_pdf_url(tmp_path):
    from compiler.refresh_sections import _read_existing_game
    _write_index(tmp_path, "root", extra_frontmatter='pdf_url: "https://example.com/root.pdf"\n')
    result = _read_existing_game(str(tmp_path), "root")
    assert result["pdf_url"] == "https://example.com/root.pdf"


def test_read_existing_game_extracts_base_game_slug(tmp_path):
    from compiler.refresh_sections import _read_existing_game
    _write_index(tmp_path, "pandemic-in-the-lab-2014", extra_frontmatter="base_game_slug: pandemic-2008\n")
    result = _read_existing_game(str(tmp_path), "pandemic-in-the-lab-2014")
    assert result["base_game_slug"] == "pandemic-2008"


def test_read_existing_game_exits_when_slug_not_in_wiki(tmp_path):
    from compiler.refresh_sections import _read_existing_game
    with pytest.raises(SystemExit) as exc:
        _read_existing_game(str(tmp_path), "nonexistent-slug")
    assert exc.value.code == 1


# ── main() path tests ────────────────────────────────────────────────────────

def test_main_regenerates_only_requested_section(tmp_path):
    _write_index(tmp_path, "root")

    with (
        patch("compiler.refresh_sections.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", return_value=(TEACHING_ONLY, [])) as mock_compile,
        patch("compiler.refresh_sections.update_sections") as mock_update,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))

    compile_kwargs = mock_compile.call_args.kwargs
    assert compile_kwargs["only_sections"] == {"teaching"}
    update_args = mock_update.call_args[0]
    assert update_args[1] == "root"
    assert update_args[2] == TEACHING_ONLY


def test_main_preserves_existing_slug_and_edition_not_recomputed(tmp_path):
    _write_index(tmp_path, "root")
    # fetch_game returns a DIFFERENT slug/no-edition — main() must not use it.
    fresh_bgg_data = {**GAME_DATA, "slug": "root-renamed-on-bgg"}
    captured = {}

    def capture_compile(game_data, *args, **kwargs):
        captured.update(game_data)
        return (TEACHING_ONLY, [])

    with (
        patch("compiler.refresh_sections.fetch_game", return_value=fresh_bgg_data),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", side_effect=capture_compile),
        patch("compiler.refresh_sections.update_sections"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))

    assert captured["slug"] == "root"
    assert captured["edition"] == "2018"


def test_main_redownloads_pdf_when_frontmatter_has_pdf_url(tmp_path):
    _write_index(tmp_path, "root", extra_frontmatter='pdf_url: "https://example.com/root.pdf"\n')

    with (
        patch("compiler.refresh_sections.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.refresh_sections.fetch_pdf", return_value=b"%PDF") as mock_fetch_pdf,
        patch("compiler.refresh_sections.extract_text", return_value="Rulebook text") as mock_extract,
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", return_value=(TEACHING_ONLY, [])) as mock_compile,
        patch("compiler.refresh_sections.update_sections"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))

    mock_fetch_pdf.assert_called_once_with("https://example.com/root.pdf")
    mock_extract.assert_called_once_with(b"%PDF")
    compile_args = mock_compile.call_args[0]
    assert compile_args[1] == "Rulebook text"  # rulebook_text
    assert compile_args[2] == b"%PDF"           # pdf_bytes


def test_main_llm_only_when_no_pdf_url_applies_warning(tmp_path):
    _write_index(tmp_path, "root")

    with (
        patch("compiler.refresh_sections.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", return_value=(TEACHING_ONLY, [])),
        patch("compiler.refresh_sections.update_sections") as mock_update,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))

    update_kwargs = mock_update.call_args.kwargs
    assert "[!WARNING]" in update_kwargs["warning"]


def test_main_sets_expansion_fields_from_frontmatter(tmp_path):
    _write_index(tmp_path, "pandemic-2008")
    _write_index(tmp_path, "pandemic-in-the-lab-2014", extra_frontmatter="base_game_slug: pandemic-2008\n")
    captured = {}

    def capture_compile(game_data, *args, **kwargs):
        captured.update(game_data)
        return (TEACHING_ONLY, [])

    with (
        patch("compiler.refresh_sections.fetch_game", return_value={**GAME_DATA, "is_expansion": True}),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", side_effect=capture_compile),
        patch("compiler.refresh_sections.update_sections"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        main(slug="pandemic-in-the-lab-2014", sections={"teaching"}, wiki_path=str(tmp_path))

    assert captured["is_expansion"] is True
    assert captured["base_game_slug"] == "pandemic-2008"
    assert captured["base_game_name"] == "Root"  # name field written by _write_index helper


def test_main_exits_when_base_game_not_in_wiki(tmp_path):
    _write_index(tmp_path, "pandemic-in-the-lab-2014", extra_frontmatter="base_game_slug: pandemic-2008\n")
    # Note: "pandemic-2008" is intentionally never written to tmp_path/games/.

    with (
        patch("compiler.refresh_sections.fetch_game", return_value={**GAME_DATA, "is_expansion": True}),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        with pytest.raises(SystemExit) as exc:
            main(slug="pandemic-in-the-lab-2014", sections={"teaching"}, wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_exits_on_invalid_section_name(tmp_path):
    _write_index(tmp_path, "root")
    with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}):
        from compiler.refresh_sections import main
        with pytest.raises(SystemExit) as exc:
            main(slug="root", sections={"not-a-real-section"}, wiki_path=str(tmp_path))
        assert exc.value.code == 1


def test_main_exits_when_all_requested_sections_fail(tmp_path):
    _write_index(tmp_path, "root")
    with (
        patch("compiler.refresh_sections.fetch_game", return_value=GAME_DATA.copy()),
        patch("compiler.refresh_sections.DeepSeekProvider"),
        patch("compiler.refresh_sections.GeminiProvider"),
        patch("compiler.refresh_sections.compile_game", return_value=({}, ["teaching"])),
        patch("compiler.refresh_sections.update_sections") as mock_update,
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k", "GEMINI_API_KEY": "k"}),
    ):
        from compiler.refresh_sections import main
        with pytest.raises(SystemExit) as exc:
            main(slug="root", sections={"teaching"}, wiki_path=str(tmp_path))
        assert exc.value.code == 1
    mock_update.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/test_refresh_sections.py -v`
Expected: FAIL on collection — `ModuleNotFoundError: No module named 'compiler.refresh_sections'`.

- [ ] **Step 3: Implement `refresh_sections.py`**

Create `scripts/compiler/refresh_sections.py`:

```python
import argparse
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compiler.bgg_fetcher import fetch_game
from compiler.pdf_fetcher import fetch_pdf
from compiler.pdf_parser import extract_text
from compiler.llm_provider import DeepSeekProvider, GeminiProvider
from compiler.llm_compiler import compile_game, SECTION_ORDER
from compiler.wiki_writer import update_sections, _llm_only_warning

VALID_SECTIONS = set(SECTION_ORDER)


def _frontmatter_field(content: str, key: str) -> str | None:
    match = re.search(rf'^{key}:\s*"?([^"\n]+)"?', content, re.MULTILINE)
    return match.group(1).strip() if match else None


def _read_existing_game(wiki_path: str, slug: str) -> dict:
    index_path = Path(wiki_path) / "games" / slug / "index.md"
    if not index_path.exists():
        print(f"Error: no existing wiki entry for slug '{slug}' at {index_path}", file=sys.stderr)
        sys.exit(1)
    content = index_path.read_text()
    bgg_id = _frontmatter_field(content, "bgg_id")
    if bgg_id is None:
        print(f"Error: {index_path} has no bgg_id in frontmatter", file=sys.stderr)
        sys.exit(1)
    return {
        "bgg_id": int(bgg_id),
        "edition": _frontmatter_field(content, "edition") or "unknown",
        "pdf_url": _frontmatter_field(content, "pdf_url"),
        "base_game_slug": _frontmatter_field(content, "base_game_slug"),
    }


def _base_game_name(wiki_path: str, base_game_slug: str) -> str:
    index_path = Path(wiki_path) / "games" / base_game_slug / "index.md"
    if not index_path.exists():
        print(f"Error: base game '{base_game_slug}' not found in wiki.", file=sys.stderr)
        sys.exit(1)
    name = _frontmatter_field(index_path.read_text(), "name")
    if name is None:
        print(f"Error: {index_path} has no name in frontmatter", file=sys.stderr)
        sys.exit(1)
    return name


def main(slug: str, sections: set[str], wiki_path: str) -> None:
    invalid = sections - VALID_SECTIONS
    if invalid:
        print(
            f"Error: invalid section(s) {sorted(invalid)}. Valid: {sorted(VALID_SECTIONS)}",
            file=sys.stderr,
        )
        sys.exit(1)

    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN")
    deepseek_provider = DeepSeekProvider(api_key=os.environ["DEEPSEEK_API_KEY"])
    gemini_provider = GeminiProvider(api_key=os.environ["GEMINI_API_KEY"])

    existing = _read_existing_game(wiki_path, slug)

    print(f"Fetching fresh BGG data for bgg_id {existing['bgg_id']}...")
    game_data = fetch_game(existing["bgg_id"], token=bgg_token)
    game_data["slug"] = slug
    game_data["edition"] = existing["edition"]

    if existing["base_game_slug"]:
        game_data["is_expansion"] = True
        game_data["base_game_slug"] = existing["base_game_slug"]
        game_data["base_game_name"] = _base_game_name(wiki_path, existing["base_game_slug"])

    pdf_url = existing["pdf_url"]
    if pdf_url:
        print(f"Downloading PDF from {pdf_url}...")
        pdf_bytes = fetch_pdf(pdf_url)
        rulebook_text = extract_text(pdf_bytes)
        if not rulebook_text:
            print("Error: PDF extracted no text.", file=sys.stderr)
            sys.exit(1)
        print(f"Extracted {len(rulebook_text)} characters from PDF.")
    else:
        pdf_bytes = None
        rulebook_text = None

    print(f"Regenerating section(s) {sorted(sections)} for '{game_data['name']}' ({slug})...")
    generated, failures = compile_game(
        game_data, rulebook_text, pdf_bytes,
        deepseek_provider, gemini_provider,
        only_sections=sections,
    )

    if not generated:
        print(f"Error: all requested section(s) failed to generate: {failures}", file=sys.stderr)
        sys.exit(1)

    warning = _llm_only_warning(game_data["edition"]) if not rulebook_text else ""
    update_sections(wiki_path, slug, generated, game_data["name"], warning=warning)

    print(f"Done! Refreshed {sorted(generated.keys())} for '{game_data['name']}'.")
    if failures:
        print(f"Warning: {len(failures)} section(s) failed: {failures}")
        sys.exit(len(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Regenerate specific wiki sections for an already-imported game"
    )
    parser.add_argument("--slug", type=str, required=True)
    parser.add_argument(
        "--sections", type=str, required=True,
        help="Comma-separated section names, e.g. 'teaching' or 'teaching,faq'",
    )
    parser.add_argument("--wiki_path", type=str, required=True)
    args = parser.parse_args()

    sections = {s.strip() for s in args.sections.split(",") if s.strip()}
    main(slug=args.slug, sections=sections, wiki_path=args.wiki_path)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/test_refresh_sections.py -v`
Expected: PASS — all 11 tests pass.

- [ ] **Step 5: Run the full Python suite to check for regressions**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/ -v`
Expected: PASS — every test in `tests/compiler/` passes, including the untouched `test_add_game.py` and `test_bulk_import.py` suites (confirms `refresh_sections.py` didn't collide with anything, and Task 1/2's changes remain backward compatible).

- [ ] **Step 6: Manual smoke test against a real game (optional but recommended before relying on this for many games)**

Requires a local checkout of `mybgg-wiki` and real `DEEPSEEK_API_KEY`/`GEMINI_API_KEY`/`GAMECACHE_BGG_TOKEN` env vars.

```bash
cd /home/carlos-ardila/Documents/gitprojects/mybgg
python -m compiler.refresh_sections --slug 11-nimmt-2010 --sections teaching \
  --wiki_path /home/carlos-ardila/Documents/gitprojects/mybgg-wiki
```

Confirm via `git -C /home/carlos-ardila/Documents/gitprojects/mybgg-wiki diff HEAD~1` (after it commits) that **only** `games/11-nimmt-2010/teaching.md` changed, and that the new content is in Spanish, in the block structure from the Task 1 prompt (guided-teaching-mode plan) — not the old English instructor-notes format.

- [ ] **Step 7: Commit**

```bash
cd /home/carlos-ardila/Documents/gitprojects/mybgg
git add scripts/compiler/refresh_sections.py tests/compiler/test_refresh_sections.py
git commit -m "$(cat <<'EOF'
feat: add refresh_sections.py to regenerate one game's sections

Lets already-imported games get e.g. their teaching.md refreshed to
the new Spanish learner-facing format without a full 6-section
reimport — reads slug/edition/pdf_url from the existing wiki entry's
frontmatter instead of requiring them as flags again.
EOF
)"
```

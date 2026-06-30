# Expansion Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect BGG expansions and adjust LLM prompts, frontmatter, and wiki cross-links so expansions are compiled as addenda to their base game rather than standalone titles.

**Architecture:** `bgg_fetcher` exposes `is_expansion` and `base_game_id` from BGG's `type` and `expansions` fields. `add_game` looks up the base game in the wiki by `bgg_id`, errors if absent, then wires base game info into `game_data`. `llm_compiler` prepends an expansion context block to all 6 prompts. `wiki_writer` adds base game fields to frontmatter and maintains an `## Expansions` section in the base game's `index.md`.

**Tech Stack:** Python 3.13, pytest, pathlib (stdlib)

## Global Constraints

- Python 3.13
- TDD: write failing tests before implementation in every task
- Run `pytest tests/` from repo root (`/home/carlos-ardila/Documents/gitprojects/mybgg`)
- No new dependencies
- Do NOT create `tests/compiler/__init__.py` — causes namespace collision
- Commit after each task

---

## File Map

| File | Change |
|---|---|
| `scripts/compiler/bgg_fetcher.py` | Add `is_expansion`, `base_game_id` to returned dict |
| `scripts/compiler/add_game.py` | Add `find_base_game_in_wiki`; expansion validation in `main()` |
| `scripts/compiler/llm_compiler.py` | Add `_expansion_block`; inject into all 6 prompts |
| `scripts/compiler/wiki_writer.py` | Expansion frontmatter fields; `_update_base_game_expansions`; stage base game in git |
| `tests/compiler/test_bgg_fetcher.py` | Tests for `is_expansion` and `base_game_id` |
| `tests/compiler/test_add_game.py` | Tests for `find_base_game_in_wiki` and expansion `main()` path |
| `tests/compiler/test_llm_compiler.py` | Tests for `_expansion_block` and prompt injection |
| `tests/compiler/test_wiki_writer.py` | Tests for expansion frontmatter and `_update_base_game_expansions` |

---

### Task 1: `bgg_fetcher.py` — expose `is_expansion` and `base_game_id`

**Files:**
- Modify: `scripts/compiler/bgg_fetcher.py`
- Modify: `tests/compiler/test_bgg_fetcher.py`

**Interfaces:**
- Produces: `fetch_game(...) -> dict` now includes `is_expansion: bool` and `base_game_id: int | None`

- [ ] **Step 1: Add failing tests to `tests/compiler/test_bgg_fetcher.py`**

Append after the existing tests:

```python
BGG_EXPANSION_DATA = {
    "id": 161936,
    "type": "boardgameexpansion",
    "name": "Pandemic: In the Lab",
    "description": "An expansion.",
    "mechanics": ["Cooperative Game"],
    "categories": ["Expansion"],
    "suggested_numplayers": [],
    "min_players": "2",
    "max_players": "4",
    "weight": "2.5",
    "rank": "Not Ranked",
    "playing_time": "45",
    "usersrated": "5000",
    "numowned": "10000",
    "rating": "7.8",
    "expansions": [{"id": 30549, "inbound": True}],
    "yearpublished": "2014",
}


def test_fetch_game_base_game_is_not_expansion():
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = [BGG_GAME_DATA]
        mock_cls.return_value = mock_client
        result = fetch_game(237182)
    assert result["is_expansion"] is False
    assert result["base_game_id"] is None


def test_fetch_game_expansion_sets_is_expansion_true():
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = [BGG_EXPANSION_DATA]
        mock_cls.return_value = mock_client
        result = fetch_game(161936)
    assert result["is_expansion"] is True
    assert result["base_game_id"] == 30549


def test_fetch_game_expansion_without_inbound_link_has_no_base_game_id():
    data = {**BGG_EXPANSION_DATA, "expansions": [{"id": 30549, "inbound": False}]}
    with patch("compiler.bgg_fetcher.BGGClient") as mock_cls:
        mock_client = MagicMock()
        mock_client.game_list.return_value = [data]
        mock_cls.return_value = mock_client
        result = fetch_game(161936)
    assert result["is_expansion"] is True
    assert result["base_game_id"] is None
```

- [ ] **Step 2: Run tests to confirm failures**

```
pytest tests/compiler/test_bgg_fetcher.py::test_fetch_game_base_game_is_not_expansion tests/compiler/test_bgg_fetcher.py::test_fetch_game_expansion_sets_is_expansion_true tests/compiler/test_bgg_fetcher.py::test_fetch_game_expansion_without_inbound_link_has_no_base_game_id -v
```

Expected: all 3 fail with `KeyError: 'is_expansion'`

- [ ] **Step 3: Update `scripts/compiler/bgg_fetcher.py`**

```python
import re
from gamecache.bgg_client import BGGClient


def fetch_game(bgg_id: int, token: str | None = None) -> dict:
    client = BGGClient(token=token)
    games = client.game_list([bgg_id])
    if not games:
        raise ValueError(f"Game {bgg_id} not found on BGG")
    raw = games[0]
    min_p = str(raw.get("min_players", "1"))
    max_p = str(raw.get("max_players", "1"))
    players = f"{min_p}-{max_p}" if min_p != max_p else min_p
    is_expansion = raw.get("type") == "boardgameexpansion"
    base_game_id = next(
        (e["id"] for e in raw.get("expansions", []) if e.get("inbound")),
        None,
    )
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
        "is_expansion": is_expansion,
        "base_game_id": base_game_id,
    }


def _to_slug(name: str) -> str:
    slug = name.lower()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    return slug.strip("-")
```

- [ ] **Step 4: Run all bgg_fetcher tests**

```
pytest tests/compiler/test_bgg_fetcher.py -v
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/bgg_fetcher.py tests/compiler/test_bgg_fetcher.py
git commit -m "feat: expose is_expansion and base_game_id from BGG fetcher"
```

---

### Task 2: `add_game.py` — `find_base_game_in_wiki` + expansion validation

**Files:**
- Modify: `scripts/compiler/add_game.py`
- Modify: `tests/compiler/test_add_game.py`

**Interfaces:**
- Consumes: `game_data["is_expansion"]: bool`, `game_data["base_game_id"]: int | None` from Task 1
- Produces: `find_base_game_in_wiki(wiki_path: str, bgg_id: int) -> dict | None` — returns `{"slug": str, "name": str}` or `None`
- Produces: `game_data["base_game_slug"]: str` and `game_data["base_game_name"]: str` when expansion found

- [ ] **Step 1: Add failing tests to `tests/compiler/test_add_game.py`**

Append after existing tests:

```python
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
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k"}),
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
        patch("compiler.add_game.compile_game", side_effect=capture_compile),
        patch("compiler.add_game.write_game"),
        patch.dict("os.environ", {"DEEPSEEK_API_KEY": "k"}),
    ):
        from compiler.add_game import main
        main(bgg_id=161936, pdf_url="https://example.com/exp.pdf",
             status="owned", wiki_path=str(tmp_path))

    assert captured["base_game_slug"] == "pandemic-2008"
    assert captured["base_game_name"] == "Pandemic"
```

- [ ] **Step 2: Run tests to confirm failures**

```
pytest tests/compiler/test_add_game.py::test_find_base_game_returns_slug_and_name tests/compiler/test_add_game.py::test_find_base_game_returns_none_when_not_found tests/compiler/test_add_game.py::test_find_base_game_ignores_partial_id_match tests/compiler/test_add_game.py::test_main_expansion_exits_when_base_game_not_in_wiki tests/compiler/test_add_game.py::test_main_expansion_sets_base_game_fields_in_game_data -v
```

Expected: all 5 fail with `ImportError` or `AttributeError`.

- [ ] **Step 3: Update `scripts/compiler/add_game.py`**

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


def find_base_game_in_wiki(wiki_path: str, bgg_id: int) -> dict | None:
    for index_file in Path(wiki_path).glob("games/*/index.md"):
        content = index_file.read_text()
        lines = content.splitlines()
        if not any(line.strip() == f"bgg_id: {bgg_id}" for line in lines):
            continue
        for line in lines:
            if line.startswith('name: "'):
                name = line.split('"')[1]
                return {"slug": index_file.parent.name, "name": name}
    return None


def main(
    bgg_id: int,
    pdf_url: str | None,
    status: str,
    wiki_path: str,
    edition: str | None = None,
) -> None:
    bgg_token = os.environ.get("GAMECACHE_BGG_TOKEN")
    deepseek_key = os.environ["DEEPSEEK_API_KEY"]

    provider = DeepSeekProvider(api_key=deepseek_key)

    print(f"Fetching BGG data for game {bgg_id}...")
    game_data = fetch_game(bgg_id, token=bgg_token)

    resolved_edition = _resolve_edition(game_data, edition)
    game_data["slug"] = f"{game_data['slug']}-{resolved_edition}"
    game_data["edition"] = resolved_edition
    print(f"Found: {game_data['name']} ({game_data['slug']})")

    if game_data.get("is_expansion") and game_data.get("base_game_id"):
        base = find_base_game_in_wiki(wiki_path, game_data["base_game_id"])
        if base is None:
            print(
                f"Error: base game (bgg_id={game_data['base_game_id']}) not found in wiki. "
                "Import the base game first.",
                file=sys.stderr,
            )
            sys.exit(1)
        game_data["base_game_slug"] = base["slug"]
        game_data["base_game_name"] = base["name"]
        print(f"Expansion of: {base['name']} ({base['slug']})")

    if pdf_url:
        print(f"Downloading PDF from {pdf_url}...")
        pdf_bytes = fetch_pdf(pdf_url)
        rulebook_text = extract_text(pdf_bytes)
        if not rulebook_text:
            print("Error: PDF extracted no text. Provide a searchable (non-scanned) PDF or use --edition without --pdf_url.", file=sys.stderr)
            sys.exit(1)
        print(f"Extracted {len(rulebook_text)} characters from PDF.")
        source = "pdf-manual"
        resolved_url: str | None = pdf_url
    else:
        if not edition:
            print("Error: --edition is required when --pdf_url is not provided.", file=sys.stderr)
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
        pdf_url=args.pdf_url,
        edition=args.edition,
        status=args.status,
        wiki_path=args.wiki_path,
    )
```

- [ ] **Step 4: Run all add_game tests**

```
pytest tests/compiler/test_add_game.py -v
```

Expected: all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/add_game.py tests/compiler/test_add_game.py
git commit -m "feat: add find_base_game_in_wiki and expansion validation in main()"
```

---

### Task 3: `llm_compiler.py` — expansion-aware prompts

**Files:**
- Modify: `scripts/compiler/llm_compiler.py`
- Modify: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: `game_data["is_expansion"]: bool`, `game_data.get("base_game_name"): str | None`
- Produces: `_expansion_block(game_data: dict) -> str` — non-empty when `is_expansion` is True
- `compile_game` and `_prompts` signatures unchanged

- [ ] **Step 1: Add failing tests to `tests/compiler/test_llm_compiler.py`**

Append after existing tests:

```python
EXPANSION_DATA = {
    **GAME_DATA,
    "name": "Pandemic: In the Lab",
    "is_expansion": True,
    "base_game_name": "Pandemic",
    "edition": "2014",
}


def test_expansion_block_is_empty_for_base_game():
    from compiler.llm_compiler import _expansion_block
    result = _expansion_block({**GAME_DATA, "is_expansion": False})
    assert result == ""


def test_expansion_block_contains_base_game_name():
    from compiler.llm_compiler import _expansion_block
    result = _expansion_block(EXPANSION_DATA)
    assert "Pandemic" in result
    assert "expansion" in result.lower()
    assert "do not repeat" in result.lower() or "focus exclusively" in result.lower()


def test_all_prompts_include_expansion_block():
    from compiler.llm_compiler import _prompts
    prompts = _prompts(EXPANSION_DATA, rulebook_text=None)
    for section, prompt_text in prompts.items():
        assert "Pandemic" in prompt_text, f"expansion block missing from '{section}' prompt"


def test_base_game_prompts_have_no_expansion_block():
    from compiler.llm_compiler import _prompts
    game_data = {**GAME_DATA, "is_expansion": False, "edition": "2018"}
    prompts = _prompts(game_data, rulebook_text=None)
    for section, prompt_text in prompts.items():
        assert "expansion" not in prompt_text.lower() or "expansion" in prompt_text.lower() and "Focus exclusively" not in prompt_text, \
            f"expansion block unexpectedly found in '{section}' prompt"
```

- [ ] **Step 2: Run tests to confirm failures**

```
pytest tests/compiler/test_llm_compiler.py::test_expansion_block_is_empty_for_base_game tests/compiler/test_llm_compiler.py::test_expansion_block_contains_base_game_name tests/compiler/test_llm_compiler.py::test_all_prompts_include_expansion_block tests/compiler/test_llm_compiler.py::test_base_game_prompts_have_no_expansion_block -v
```

Expected: all 4 fail with `ImportError: cannot import name '_expansion_block'`

- [ ] **Step 3: Update `scripts/compiler/llm_compiler.py`**

```python
from compiler.llm_provider import LLMProvider

SYSTEM = (
    "You are a board game knowledge compiler. "
    "Write clear, accurate, well-structured Markdown pages about board games. "
    "Use [[Wiki Link]] syntax for cross-references to mechanics, concepts, and game-specific terms. "
    "Write in English. Be concise and precise. Do not include YAML frontmatter."
)


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


def _expansion_block(game_data: dict) -> str:
    if not game_data.get("is_expansion"):
        return ""
    base_name = game_data.get("base_game_name", "the base game")
    return (
        f"This is an expansion for **{base_name}**. "
        "Focus exclusively on what this expansion adds: new components, new rules, new mechanics. "
        f"Do not repeat or summarize the base game rules. "
        f"Assume the reader already knows how to play {base_name}.\n\n"
    )


def _prompts(game_data: dict, rulebook_text: str | None) -> dict[str, str]:
    name = game_data["name"]
    rb = _rulebook_block(rulebook_text, game_data)
    ex = _expansion_block(game_data)
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
    return {
        "index": (
            f"{ex}Write a Markdown overview page for the board game \"{name}\".\n\n"
            f"BGG Data:\n{meta}{rb}\n"
            "Include:\n"
            "1. A 2-3 paragraph summary of what the game is and why it is interesting\n"
            "2. A 'Key Info' section with the BGG metadata as a Markdown table\n"
            "3. Links to related mechanics using [[Mechanic Name]] syntax"
        ),
        "setup": (
            f"{ex}Write a Markdown setup guide for \"{name}\".\n{rb}\n"
            "Include:\n"
            "1. Complete components list\n"
            "2. Step-by-step setup instructions (numbered)\n"
            "3. Setup variations by player count (if any)\n"
            "Use [[term]] syntax for game-specific components."
        ),
        "rules": (
            f"{ex}Write a complete Markdown rules reference for \"{name}\".\n{rb}\n"
            "Include:\n"
            "1. Turn structure (in order)\n"
            "2. Core mechanics explained clearly\n"
            "3. Special rules and edge cases\n"
            "4. End-game conditions and scoring\n"
            "5. Player count differences (if any)\n"
            "Use [[term]] syntax for game-specific terms."
        ),
        "teaching": (
            f"{ex}Write a Markdown teaching guide for explaining \"{name}\" to new players.\n{rb}\n"
            "Include these sections:\n"
            "1. **5-minute explanation** — shortest useful introduction\n"
            "2. **Suggested teaching order** — what to explain first, second, third\n"
            "3. **First-round walkthrough** — narrate a typical first round\n"
            "4. **Rules to postpone** — what to defer until it comes up naturally\n"
            "5. **Common mistakes** — what new players get wrong most often\n"
            "6. **Frequently forgotten rules** — even experienced players miss these"
        ),
        "faq": (
            f"{ex}Write a Markdown FAQ for \"{name}\" addressing common rules questions.\n{rb}\n"
            "Format as Q&A pairs. Cover:\n"
            "1. Situations that come up frequently\n"
            "2. Rules interactions commonly misunderstood\n"
            "3. Edge cases from the rulebook\n"
            "Use [[term]] syntax for game-specific terms."
        ),
        "glossary": (
            f"{ex}Write a Markdown glossary for \"{name}\" covering all game-specific terms.\n{rb}\n"
            "Format each entry as:\n"
            "## Term Name\n\n"
            "English definition (1-2 sentences).\n\n"
            "**Español:** Spanish translation or description.\n\n"
            "Order entries alphabetically. Include all components, actions, and concepts."
        ),
    }


def compile_game(
    game_data: dict,
    rulebook_text: str | None,
    provider: LLMProvider,
) -> tuple[dict[str, str], list[str]]:
    prompts = _prompts(game_data, rulebook_text)
    sections: dict[str, str] = {}
    failures: list[str] = []

    for section_name, prompt in prompts.items():
        try:
            sections[section_name] = provider.generate(system=SYSTEM, prompt=prompt)
        except Exception as e:
            print(f"Warning: failed to generate '{section_name}': {e}")
            failures.append(section_name)

    return sections, failures
```

- [ ] **Step 4: Run all llm_compiler tests**

```
pytest tests/compiler/test_llm_compiler.py -v
```

Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
git commit -m "feat: prepend expansion context block to LLM prompts for expansions"
```

---

### Task 4: `wiki_writer.py` — expansion frontmatter + base game cross-link

**Files:**
- Modify: `scripts/compiler/wiki_writer.py`
- Modify: `tests/compiler/test_wiki_writer.py`

**Interfaces:**
- Consumes: `game_data.get("is_expansion"): bool`, `game_data.get("base_game_id"): int`, `game_data.get("base_game_slug"): str`, `game_data.get("base_game_name"): str`
- Produces: `_update_base_game_expansions(wiki_path, base_game_slug, expansion_slug, expansion_name) -> None`
- `write_game` and `_build_frontmatter` signatures unchanged

- [ ] **Step 1: Add failing tests to `tests/compiler/test_wiki_writer.py`**

Append after existing tests:

```python
GAME_DATA_EXPANSION = {
    "id": 161936,
    "name": "Pandemic: In the Lab",
    "slug": "pandemic-in-the-lab-2014",
    "edition": "2014",
    "yearpublished": 2014,
    "mechanics": ["Cooperative Game"],
    "players": "2-4",
    "weight": "2.5",
    "rank": "Not Ranked",
    "is_expansion": True,
    "base_game_id": 30549,
    "base_game_slug": "pandemic-2008",
    "base_game_name": "Pandemic",
}


def test_expansion_frontmatter_includes_base_game_fields():
    fm = _build_frontmatter(GAME_DATA_EXPANSION, "owned", "pdf-manual", None)
    assert "base_game_bgg_id: 30549" in fm
    assert 'base_game_slug: pandemic-2008' in fm


def test_base_game_frontmatter_has_no_expansion_fields():
    fm = _build_frontmatter(GAME_DATA_WITH_EDITION, "owned", "pdf-manual", None)
    assert "base_game_bgg_id" not in fm
    assert "base_game_slug" not in fm


def test_update_base_game_creates_expansions_section(tmp_path):
    from compiler.wiki_writer import _update_base_game_expansions
    base_dir = tmp_path / "games" / "pandemic-2008"
    base_dir.mkdir(parents=True)
    (base_dir / "index.md").write_text("---\nbgg_id: 30549\n---\n\n# Pandemic\n\nGreat game.")

    _update_base_game_expansions(str(tmp_path), "pandemic-2008", "pandemic-in-the-lab-2014", "Pandemic: In the Lab")

    content = (base_dir / "index.md").read_text()
    assert "## Expansions" in content
    assert "[[pandemic-in-the-lab-2014]]" in content
    assert "Pandemic: In the Lab" in content


def test_update_base_game_appends_to_existing_expansions_section(tmp_path):
    from compiler.wiki_writer import _update_base_game_expansions
    base_dir = tmp_path / "games" / "pandemic-2008"
    base_dir.mkdir(parents=True)
    (base_dir / "index.md").write_text(
        "---\nbgg_id: 30549\n---\n\n# Pandemic\n\n## Expansions\n\n- [[pandemic-on-the-brink-2009]] — On the Brink\n"
    )

    _update_base_game_expansions(str(tmp_path), "pandemic-2008", "pandemic-in-the-lab-2014", "Pandemic: In the Lab")

    content = (base_dir / "index.md").read_text()
    assert "[[pandemic-on-the-brink-2009]]" in content
    assert "[[pandemic-in-the-lab-2014]]" in content
    assert content.count("## Expansions") == 1


def test_update_base_game_does_not_duplicate_entry(tmp_path):
    from compiler.wiki_writer import _update_base_game_expansions
    base_dir = tmp_path / "games" / "pandemic-2008"
    base_dir.mkdir(parents=True)
    (base_dir / "index.md").write_text(
        "---\nbgg_id: 30549\n---\n\n## Expansions\n\n- [[pandemic-in-the-lab-2014]] — Pandemic: In the Lab\n"
    )

    _update_base_game_expansions(str(tmp_path), "pandemic-2008", "pandemic-in-the-lab-2014", "Pandemic: In the Lab")

    content = (base_dir / "index.md").read_text()
    assert content.count("pandemic-in-the-lab-2014") == 1


def test_write_game_expansion_calls_update_base_game(tmp_path):
    with (
        patch("compiler.wiki_writer._git_commit_and_push"),
        patch("compiler.wiki_writer._update_base_game_expansions") as mock_update,
    ):
        write_game(GAME_DATA_EXPANSION, SECTIONS, str(tmp_path), "owned", "pdf-manual")

    mock_update.assert_called_once_with(
        str(tmp_path), "pandemic-2008", "pandemic-in-the-lab-2014", "Pandemic: In the Lab"
    )


def test_write_game_base_game_does_not_call_update(tmp_path):
    with (
        patch("compiler.wiki_writer._git_commit_and_push"),
        patch("compiler.wiki_writer._update_base_game_expansions") as mock_update,
    ):
        write_game(GAME_DATA_WITH_EDITION, SECTIONS, str(tmp_path), "owned", "pdf-manual")

    mock_update.assert_not_called()
```

- [ ] **Step 2: Run tests to confirm failures**

```
pytest tests/compiler/test_wiki_writer.py::test_expansion_frontmatter_includes_base_game_fields tests/compiler/test_wiki_writer.py::test_base_game_frontmatter_has_no_expansion_fields tests/compiler/test_wiki_writer.py::test_update_base_game_creates_expansions_section tests/compiler/test_wiki_writer.py::test_update_base_game_appends_to_existing_expansions_section tests/compiler/test_wiki_writer.py::test_update_base_game_does_not_duplicate_entry tests/compiler/test_wiki_writer.py::test_write_game_expansion_calls_update_base_game tests/compiler/test_wiki_writer.py::test_write_game_base_game_does_not_call_update -v
```

Expected: all 7 fail.

- [ ] **Step 3: Update `scripts/compiler/wiki_writer.py`**

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

    if game_data.get("is_expansion") and game_data.get("base_game_slug"):
        _update_base_game_expansions(
            wiki_path,
            game_data["base_game_slug"],
            game_data["slug"],
            game_data["name"],
        )

    _git_commit_and_push(
        wiki_path,
        game_data["slug"],
        game_data["name"],
        game_data.get("base_game_slug"),
    )


def _llm_only_warning(edition: str) -> str:
    return (
        "> [!WARNING]\n"
        "> Contenido generado desde conocimiento general del LLM sin rulebook verificado.\n"
        f"> Edición de referencia: **{edition}**. Puede diferir de otras ediciones.\n\n"
    )


def _update_base_game_expansions(
    wiki_path: str,
    base_game_slug: str,
    expansion_slug: str,
    expansion_name: str,
) -> None:
    index_path = Path(wiki_path) / "games" / base_game_slug / "index.md"
    if not index_path.exists():
        return
    content = index_path.read_text()
    new_entry = f"- [[{expansion_slug}]] — {expansion_name}"
    if new_entry in content:
        return
    if "## Expansions" in content:
        content = content.rstrip() + f"\n{new_entry}\n"
    else:
        content = content.rstrip() + f"\n\n## Expansions\n\n{new_entry}\n"
    index_path.write_text(content)


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
    if game_data.get("is_expansion"):
        lines.append(f"base_game_bgg_id: {game_data['base_game_id']}")
        lines.append(f"base_game_slug: {game_data['base_game_slug']}")
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


def _git(wiki_path: str, *args: str) -> None:
    subprocess.run(["git", "-C", wiki_path, *args], check=True, capture_output=True)
```

- [ ] **Step 4: Run all wiki_writer tests**

```
pytest tests/compiler/test_wiki_writer.py -v
```

Expected: all 17 tests pass.

- [ ] **Step 5: Run full test suite**

```
pytest tests/ -v
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/compiler/wiki_writer.py tests/compiler/test_wiki_writer.py
git commit -m "feat: add expansion frontmatter and bidirectional wiki cross-links"
```

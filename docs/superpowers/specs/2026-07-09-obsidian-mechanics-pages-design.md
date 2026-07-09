# Obsidian Mechanics Pages

**Date:** 2026-07-09
**Scope:** Have the compiler create/update `/mechanics/*.md` notes in the wiki vault so mechanics are browsable and visible in Obsidian's native graph view (Ctrl+G). Does not touch the chat/Worker layer.

---

## Problem

Games in the wiki carry a `mechanics` list in frontmatter (sourced from BGG, unchanged by this project) and the compiler already writes `[[Mechanic Name]]` wikilinks into generated prose (`index.md`, `rules.md`, etc.). But there is no note at the other end of those links — `[[Area Control]]` currently points to a note that doesn't exist. There's no way to browse "which games in my collection use Area Control" or see the mechanics graph in Obsidian.

## Non-goals

- **No `graph_index.json` or precomputed relational graph in KV.** The chat's `discovery` mode already receives the full catalog (including `mechanics` and `categories` per game, sourced from the existing `gamecache`/BGG pipeline — independent of wiki import status) and already reasons over it directly in the system prompt. There's no observed failure in current chat recommendations to justify a structured similarity layer. If real gaps show up later (recommendations feel wrong, or the catalog grows large enough that sending it in full becomes a real cost/latency problem), that's a separate future spec — not blocked by anything here.
- **No changes to the Worker, KV schema, or chat prompts.** This is purely a compiler-side, Obsidian-side feature.
- **No changes to `llm_compiler.py`'s existing `[[term]]` wikilink instructions** — those already work; this project just makes sure the link targets exist.

---

## Architecture

```
add_game.py, after compile_game() succeeds, before/alongside write_game():
  for each mechanic in game_data["mechanics"]:
      mechanic_page_exists(wiki_path, mechanic)?
        No  → generate_mechanic_description(mechanic, deepseek_provider)   [1 short LLM call]
              → collect into { mechanic: description } dict
        Yes → skip (no LLM call)
  sync_mechanic_pages(wiki_path, game_data, descriptions)
      → creates new pages (title + description + backlink)
      → appends backlink to existing pages if this game isn't already listed (idempotent)
  mechanics/ is staged into the SAME commit as games/{slug}/ (one commit per import)
```

---

## Components

### `scripts/compiler/llm_compiler.py`

```python
def generate_mechanic_description(name: str, provider: DeepSeekProvider) -> str:
    """
    One short text call. Prompt: describe the board game mechanic "{name}"
    in 1-2 sentences, for a personal Obsidian wiki. No frontmatter, no heading.
    """
```

Uses `DeepSeekProvider` — same as `index`/`teaching`/`faq`/`glossary`, no Gemini/multimodal involvement.

### `scripts/compiler/wiki_writer.py`

Two additions, following the exact idempotency pattern already used by `_update_base_game_expansions`:

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
                continue  # already linked, no-op
            page_path.write_text(content.rstrip() + f"\n{entry}\n")
        else:
            description = descriptions[mechanic]
            page_path.parent.mkdir(parents=True, exist_ok=True)
            page_path.write_text(
                f"# {mechanic}\n\n{description}\n\n"
                f"## Juegos en tu catálogo que la usan:\n{entry}\n"
            )
```

`_git_commit_and_push` gains `_git(wiki_path, "add", "mechanics/")` alongside the existing `games/{slug}/` add, so mechanics pages land in the same commit as the game import.

### `scripts/compiler/add_game.py`

Orchestration, inserted after `compile_game` succeeds and before/alongside `write_game`:

```python
from compiler.wiki_writer import mechanic_page_exists, sync_mechanic_pages

new_mechanics = [m for m in game_data.get("mechanics", []) if not mechanic_page_exists(wiki_path, m)]
descriptions = {m: generate_mechanic_description(m, provider) for m in new_mechanics}
sync_mechanic_pages(wiki_path, game_data, descriptions)
```

(`provider` here is the existing `DeepSeekProvider` instance already constructed in `add_game.py` for the other text sections — no new provider needed.)

---

## Naming convention

`/mechanics/{Mechanic Name}.md`, using the **exact BGG string** already present in frontmatter and already used by the compiler's `[[Mechanic Name]]` wikilink instructions (`llm_compiler.py`'s `SYSTEM` prompt). No slugification — Obsidian resolves wikilinks by note title regardless of spaces, and this guarantees existing/future `[[Area Control]]` links in generated prose resolve without any change to how those links are written today.

## Page template

```markdown
# Area Control

Mecánica de juego donde los jugadores compiten por la influencia o dominio de áreas del mapa.

## Juegos en tu catálogo que la usan:
* [[root-2018]] — Root
```

---

## Error handling

- `generate_mechanic_description` failure for one mechanic → follows the same pattern as other section failures: log and skip that mechanic's page creation this run (it'll be retried next time a game with that mechanic is imported, since the page still won't exist). Does not abort the import — mechanics pages are a nice-to-have layered on top of a successful game import, not a prerequisite for it.
- Existing mechanic pages are never overwritten, only appended to — manual edits/descriptions you make in Obsidian are preserved.

---

## Cost

One short DeepSeek text call, only the first time a given mechanic is ever seen across the whole collection (not per game). A personal collection has a bounded, small set of unique mechanics (tens, not hundreds), so total cost across all future imports is marginal — effectively a rounding error next to the existing per-game section costs.

---

## Testing

- `mechanic_page_exists`: true/false cases.
- `sync_mechanic_pages`: creates new page with correct content; appends backlink to existing page without duplicating; no-ops when the game is already linked.
- `add_game.py` orchestration (mocked provider): only calls `generate_mechanic_description` for mechanics without an existing page; skips the call entirely when all of a game's mechanics already have pages.

---

## Out of scope / future work

- Structured `graph_index.json` and Worker-side similarity/filtering for the chat's `discovery` mode — deferred until there's observed evidence current recommendations are insufficient, or the catalog grows large enough that full-catalog-in-prompt becomes a real cost/latency issue.
- Any UI for browsing mechanics outside Obsidian.
- Curated mechanic taxonomies/groupings beyond BGG's raw mechanic strings.

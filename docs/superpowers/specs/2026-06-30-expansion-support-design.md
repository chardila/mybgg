# Design: Expansion Support

**Date:** 2026-06-30
**Status:** Approved

## Problem

Expansions imported with the current system are treated identically to base games. The LLM prompts ask for "complete rules reference" and "full components list", which causes expansions to either repeat base game content or produce incomplete pages. There is also no link between expansion and base game in the wiki.

## Decision

Add automatic expansion detection using BGG's `type` field and `inbound` expansion links. When a game is an expansion, adjust LLM prompts to focus only on what the expansion adds, and create bidirectional cross-links in the wiki between the expansion and its base game.

If the base game has not yet been imported to the wiki, the import fails with an error requiring the user to import the base game first.

## Architecture

### Detection and data flow

**`scripts/compiler/bgg_fetcher.py`**

Expose two new fields in the returned game_data dict:

- `is_expansion: bool` — `True` when BGG returns `type == "boardgameexpansion"`
- `base_game_id: int | None` — ID of the base game, taken from the first entry in the `expansions` array where `inbound=True`. `None` for base games.

The BGG client already parses `type` and the `expansions` array with `inbound` — this is a read-through, no new API calls.

**`scripts/compiler/add_game.py`**

Add `find_base_game_in_wiki(wiki_path: str, bgg_id: int) -> dict | None`.

This function scans all `games/*/index.md` files in the wiki, reads the frontmatter of each, and returns `{"slug": str, "name": str}` for the entry whose `bgg_id` matches. Returns `None` if not found.

In `main()`, after fetching game data:

```python
if game_data["is_expansion"]:
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
```

No additional BGG API call — base game name and slug are read from existing wiki frontmatter.

### LLM prompts

**`scripts/compiler/llm_compiler.py`**

Add `_expansion_block(game_data: dict) -> str` that returns an expansion context string when `game_data.get("is_expansion")` is True:

```
This is an expansion for **{base_game_name}**. Focus exclusively on what
this expansion adds: new components, new rules, new mechanics. Do not
repeat or summarize the base game rules. Assume the reader already knows
how to play {base_game_name}.
```

Returns `""` for base games. This block is prepended to every prompt in `_prompts()`.

### Wiki output

**`scripts/compiler/wiki_writer.py`**

Two changes:

**Expansion frontmatter:** When `game_data.get("is_expansion")` is True, add to frontmatter:

```yaml
base_game_bgg_id: {base_game_id}
base_game_slug: {base_game_slug}
```

**Base game index.md update:** After writing the expansion files, call `_update_base_game_expansions(wiki_path, base_game_slug, expansion_slug, expansion_name)`. This function:

1. Reads `{wiki_path}/games/{base_game_slug}/index.md`
2. Looks for a `## Expansions` section at the end
3. If found: appends `- [[{expansion_slug}]] — {expansion_name}` to the list (only if not already present)
4. If not found: appends the full section to the end of the file
5. Writes the file back

`write_game` must explicitly stage the base game's modified index.md in addition to the expansion directory. The current `_git_commit_and_push` only stages `games/{slug}/`, so `write_game` passes the optional base game path to a new `_git_stage` call before committing.

## Validation

| Condition | Result |
|---|---|
| `type == "boardgame"` | Normal import, no expansion logic |
| `type == "boardgameexpansion"`, base game in wiki | Expansion import with adjusted prompts + bidirectional links |
| `type == "boardgameexpansion"`, base game NOT in wiki | Error + `sys.exit(1)` |
| `type == "boardgameexpansion"`, `inbound` link missing | Treat as base game (defensive fallback) |

## New fields in game_data

| Field | Type | Present when |
|---|---|---|
| `is_expansion` | `bool` | Always |
| `base_game_id` | `int \| None` | Always (`None` for base games) |
| `base_game_slug` | `str` | `is_expansion == True` and base game found |
| `base_game_name` | `str` | `is_expansion == True` and base game found |

## No workflow changes

Expansion detection is fully automatic. The `import-game.yml` workflow requires no new inputs.

## Tests

- `bgg_fetcher`: test that `is_expansion=True` and `base_game_id` are set correctly when BGG returns `type="boardgameexpansion"` with an `inbound` link
- `add_game`: test `find_base_game_in_wiki` finds by `bgg_id`; test error when base game missing; test expansion path populates `base_game_slug` and `base_game_name`
- `llm_compiler`: test `_expansion_block` returns non-empty string for expansions, empty string for base games; test expansion context appears in all 6 prompts
- `wiki_writer`: test expansion frontmatter includes `base_game_bgg_id` and `base_game_slug`; test `_update_base_game_expansions` creates section when absent and appends when present without duplicating

# Edition Support — Design

**Date:** 2026-06-30
**Scope:** Add edition awareness to the Knowledge Compiler so different editions of the same game get separate wiki folders, differentiated by publication year (from BGG) or a manual override.

---

## Problem

The compiler uses a slug derived from the game name (`pandemic`) as the wiki folder key. If a user has two physical editions of the same game with different rules, re-importing the game overwrites the existing wiki entry. There is no way to keep both editions' rules documented simultaneously.

---

## Solution

Always include an edition identifier in the slug: `pandemic-2013`. The edition defaults to `yearpublished` fetched from BGG. An optional `--edition` CLI argument (and corresponding workflow input) overrides it with custom text (e.g., `kickstarter`, `edicion-espanol`).

**Slug construction:**
```
{name-slug}-{edition-slug}

Examples:
  Pandemic (2013)     → pandemic-2013
  Root (2018)         → root-2018
  Pandemic (custom)   → pandemic-kickstarter
```

**Breaking change:** Existing wiki entries imported without a year (`pandemic`) are not migrated automatically. Re-importing an existing game creates a new folder (`pandemic-2013`) and leaves the old one untouched. The user can delete old folders manually if desired.

---

## Files Changed

Only `scripts/compiler/` in `mybgg` is modified. The wiki, Worker, chat, and GitHub Pages are unchanged.

```
scripts/compiler/
├── bgg_fetcher.py     ← add yearpublished to returned dict
├── add_game.py        ← accept --edition arg, build slug with edition
├── llm_compiler.py    ← include edition in prompts
└── wiki_writer.py     ← add edition + yearpublished to frontmatter
```

---

## Module Changes

### `bgg_fetcher.py`

Add `yearpublished` to the dict returned by `fetch_game()`.

BGG XML API returns `<yearpublished value="2013"/>`. Parse it as an integer. If absent, default to `0`.

Updated return dict adds:
```python
"yearpublished": int(raw.get("yearpublished", 0)),
```

### `add_game.py`

Add `--edition` optional CLI argument (string, default `None`).

Slug construction after fetching BGG data:
```python
def _resolve_edition(game_data: dict, edition_override: str | None) -> str:
    if edition_override:
        return _to_slug(edition_override)
    year = game_data.get("yearpublished", 0)
    return str(year) if year else "unknown"

# After fetch_game():
edition = _resolve_edition(game_data, args.edition)
game_data["slug"] = f"{game_data['slug']}-{edition}"
game_data["edition"] = edition
```

`_to_slug` is imported from `bgg_fetcher` (already used for name slug).

### `llm_compiler.py`

Include edition in prompts so the LLM targets the correct version's rules.

In `_prompts()`, the `meta` block gains one line:
```python
f"- Edition: {game_data.get('edition', 'unknown')}\n"
```

This appears in all six section prompts via the shared `meta` variable.

### `wiki_writer.py`

Add two fields to the frontmatter block in `_build_frontmatter()`:

```yaml
edition: "2013"
yearpublished: 2013
```

`edition` is the slug component (string, could be a year or custom text).
`yearpublished` is always the integer year from BGG (0 if BGG did not provide it).

Both are written after the `source` field.

---

## GitHub Actions Workflow

Add optional `edition` input to `import-game.yml`:

```yaml
edition:
  description: 'Edition label (optional — defaults to BGG publication year)'
  required: false
  type: string
  default: ''
```

Pass it through to the script:
```bash
if [ -n "$EDITION" ]; then
  ARGS="$ARGS --edition $EDITION"
fi
```

---

## Frontmatter Schema (updated)

```yaml
---
bgg_id: 161936
name: "Pandemic Legacy: Season 1"
slug: pandemic-legacy-season-1-2015
status: owned
edition: "2015"
yearpublished: 2015
source: pdf-manual
pdf_url: "https://..."
players: "2-4"
weight: 3.63
rank: 3
mechanics:
  - Cooperative
imported: 2026-06-30
---
```

---

## Error Handling

| Case | Behavior |
|---|---|
| BGG does not return `yearpublished` | `yearpublished: 0`, edition slug becomes `"unknown"` → slug: `pandemic-unknown` |
| `--edition` contains special characters | `_to_slug()` normalizes to safe slug (same function used for game names) |
| Resulting slug collides with existing wiki folder | Files are overwritten (same behavior as today — user controls slug via `--edition` override) |

---

## Out of Scope

- Automatic migration of existing wiki entries to include the year in their slugs
- Detecting slug collisions and prompting the user
- Displaying edition in the chat UI or catalog

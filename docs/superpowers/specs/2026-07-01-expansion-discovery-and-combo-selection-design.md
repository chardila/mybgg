# Design: Expansions in Discovery + Combo Selection for Deep Dive

**Date:** 2026-07-01
**Status:** Approved

## Problem

Expansions are already imported and cross-linked in the wiki (see [2026-06-30-expansion-support-design.md](2026-06-30-expansion-support-design.md)), but the chat product is unaware of them:

- `catalog.json` (built by `mybgg-wiki/scripts/build_catalog.py`) only lists games flat, with no link between a base game and its expansions. The discovery system prompt never mentions expansions, so the LLM can't suggest "play X with expansion Y" even when the user's ask (more players, more depth, a specific theme) is best solved that way.
- The game selector in `chat.html` is a single `<select>` that immediately switches to `deep_dive` for exactly one slug. Real usage is base-only, base + one expansion, or base + several expansions (some owned games have many). There's no way to select a combo, and `deep_dive` context building in the Worker only ever loads one game's KV sections.

This spec covers two repos: `mybgg-wiki` (catalog data) and `mybgg` (Worker + `chat.html`).

## Decision

1. `build_catalog.py` nests each base game's expansions under it while keeping every game (base and expansion) in the flat top-level list.
2. The discovery system prompt is updated to reason over nested expansions and proactively ask clarifying questions to help the user narrow down a base game + expansion combo — not just react to an already-decided choice.
3. `chat.html`'s selector becomes a two-step control: a dropdown of base games only, followed by dynamically-rendered checkboxes of that base's expansions, confirmed with a button. This starts `deep_dive` with a `game` slug plus an `expansions` array.
4. The Worker's `deep_dive` mode accepts the `expansions` array, fetches KV wiki sections for the base and each expansion in parallel, and builds one combined system prompt context, with expansion sections clearly grouped and labeled as additive (not a replacement for base rules).

## Architecture

### 1. `mybgg-wiki/scripts/build_catalog.py`

`build_catalog()` changes from a single pass to two passes:

1. Parse frontmatter for every `games/*/index.md` into the existing dict shape, plus a new field:
   - `"base_game_slug": str(fm.get("base_game_slug", ""))` — empty string for base games, populated for expansions (already present in expansion frontmatter per the prior expansion-support design).
   Every game keeps its dict in the flat top-level list, unchanged position/order.
2. Second pass: for every dict where `base_game_slug` is non-empty, look up the base game's dict by slug (index built during pass 1) and append a copy of the expansion's dict to the base's `"expansions"` list. Every base game dict gets `"expansions": []` by default before this pass runs.
   - If the referenced base game isn't found in the wiki being built (orphan expansion — e.g. partial/test wiki), skip the nesting step silently. The expansion still appears in the flat list.

Order independence: nesting happens after all frontmatter is parsed, so glob order (alphabetical) doesn't matter.

Example shape:

```json
[
  {
    "slug": "pandemic-2008", "name": "Pandemic", "players": "2-4", "weight": "2.394",
    "playing_time": "", "mechanics": [...], "categories": [], "edition": "2008",
    "status": "owned", "rank": "173", "base_game_slug": "",
    "expansions": [
      {"slug": "pandemic-on-the-brink-2009", "name": "Pandemic: On the Brink", "players": "2-5", ...}
    ]
  },
  {
    "slug": "pandemic-on-the-brink-2009", "name": "Pandemic: On the Brink", ...,
    "base_game_slug": "pandemic-2008", "expansions": []
  }
]
```

(The expansion's own dict has `"expansions": []` since expansions of expansions aren't a real case here — no need to recurse.)

### 2. Discovery system prompt (`mybgg/worker/src/index.js`)

`SYSTEM_PROMPTS.discovery.es` / `.en` gain:

- An explanation that catalog entries may include a nested `"expansions"` array.
- An instruction to actively ask clarifying questions (player count, desired depth/variety, mood) when helpful, and to use expansions in scope — including suggesting a base game with one or more specific expansions by name — rather than only ever recommending bare base games.
- A closing instruction: once a combo is decided, tell the user to pick the base game from the dropdown and check the expansion(s) they want to play.

No change to `handleChat`'s discovery branch logic — `catalog.json` is still injected raw.

### 3. `chat.html`

**Selector markup:** the existing `<select id="game-select">` stays, plus a new (initially empty/hidden) container for expansion checkboxes and a "Empezar" button, e.g.:

```html
<select id="game-select">...</select>
<div id="expansion-checkboxes"></div>
<button id="btn-start-deepdive" style="display:none">Empezar</button>
```

**`loadGames()`:** fetch `/api/games` as today, but only append `<option>`s for entries where `g.base_game_slug` is falsy. Keep the full parsed `games` array in a module-level variable (e.g. `allGames`) so expansions are available for step 2 without a second request.

**On base game selection (`change` on `#game-select`):**
- Look up the selected game's dict in `allGames`.
- If `game.expansions` is empty: skip the checkbox UI entirely and immediately start `deep_dive` for the base game alone — identical behavior to today's single-select UX. `#expansion-checkboxes` and `#btn-start-deepdive` stay hidden.
- If `game.expansions` is non-empty: render one checkbox per expansion (`value = slug`, label = `name` (+ `edition` if present, same formatting as today's dropdown labels)) into `#expansion-checkboxes`, and show `#btn-start-deepdive`. Nothing starts yet — the user must click "Empezar" (with zero or more boxes checked) to proceed. This is the only path where the button appears.

**On "Empezar" click (only reachable when the base game has expansions):** starts deep_dive the same way the no-expansions branch above does automatically:
- Read the selected base slug and the checked expansion slugs (`currentExpansions`).
- Build the combined display name: base's dropdown label + `" + "` + each checked checkbox's label, joined.
- Same as today: reset `history`, set `currentMode = 'deep_dive'`, `currentGame`, `currentGameName` (now the combined name), update mode-bar text and opening message, clear chat.

**`sendMessage()`:** POST body gains `expansions: currentExpansions` (empty array in discovery mode or base-only deep_dive).

**`resetToDiscovery()`:** also resets `currentExpansions = []`, clears/hides the checkbox container and button, resets the base `<select>`.

### 4. Worker `deep_dive` (`handleChat` in `mybgg/worker/src/index.js`)

**Request body:** `expansions` (array of strings, optional, default `[]`).

**Validation:** each entry must match `/^[a-z0-9-]+$/` (same rule as `game`); reject the whole request with `sseError` if any entry fails. Cap `expansions.length` at 10 (defensive; matches "several expansions" scale, not an arbitrary product limit) — extra entries beyond 10 are also rejected with `sseError` rather than silently truncated, so the client finds out rather than getting a silently incomplete answer.

**Context building — extracted into a pure, testable function** (new, e.g. `buildDeepDiveContext({ base, expansions, promptFn })` where `base` and each entry of `expansions` are `{ slug, index, rules, teaching, faq, glossary }` — the raw KV strings already fetched):

- Fetch: one `Promise.all` covering the base's 5 KV keys plus 5 keys per expansion slug (flattened), same `env.WIKI.get('games/{slug}/{section}')` pattern as today.
- Combined `gameName`: extract `name`/`edition` from the base's `index` via `extractFrontmatterField` exactly as today, then append `" + " + name` (no edition) for each expansion, extracted from that expansion's own `index` content.
- Combined context string:
  - Base sections exactly as today (`## Overview`, `## Rules`, `## Teaching Guide`, `## FAQ`, `## Glossary`), `.filter(Boolean)`-ed for missing sections.
  - Then, for each expansion with at least one non-empty section, a block:
    ```
    ## Expansion: {expansion name}
    ### Overview
    {expansion index}
    ### Rules (additions)
    {expansion rules}
    ...
    ```
    (sub-headings for whichever of the 5 sections are non-empty). Expansions where **all 5** KV sections are empty are omitted entirely (their checkbox pointed at wiki content that doesn't exist — silent skip, same philosophy as missing individual sections today).
- `systemContent = `${basePrompt}\n\n${combinedSections}`` where `basePrompt = promptFn(combinedGameName)`.

**Deep dive prompt copy (`SYSTEM_PROMPTS.deep_dive.es` / `.en`):** add one sentence: the context may include a base game plus one or more expansions the user selected; each expansion section describes only what it adds or changes versus the base game and does not repeat base rules; when a question needs both, combine them explicitly and make clear which rule comes from where.

**`handleDebugContext`** is left as-is (base-game-only diagnostic endpoint) — out of scope.

## Risks / open dependencies

**Player-count data quality for the "capacity" use case is unverified.** One of the two motivating scenarios (the other being mechanic/theme variety) is: "Pandemic base is 2-4, but with On the Brink it supports 5, so suggest the combo." This only works if an expansion's `players` field (fetched from BGG via `bgg_fetcher.py`, unchanged by this spec) actually encodes the *combined* capacity with the base game. BGG's own data is inconsistent here — some expansion pages list the combined range ("2-5"), some list only the added count ("5"), some just repeat the base's range, some are blank. No expansion has been imported into the wiki yet (only `pandemic-2008` exists), so this can't be verified against real data now.

This spec proceeds anyway because the discovery prompt change is worded to have the LLM *reason with whatever the catalog gives it* rather than assume a specific encoding — it is not silently broken, just potentially less useful for capacity questions than for variety questions until verified. Action: when the first expansion is imported (any expansion, not gated on this feature), manually check what `players` actually contains for it and confirm the discovery prompt's phrasing still makes sense; adjust prompt wording or add a `players` note in `add_game.py`/`bgg_fetcher.py` in a follow-up if the raw BGG value turns out unusable.

**Resolution of "sometimes it's just the expansion, not really 'base + expansion'":** the user raised this twice during brainstorming (an expansion's own wiki content assumes the reader already knows the base game and never repeats its rules — see the prior expansion-support design's `_expansion_block`). This spec resolves it by **always including full base-game context whenever any expansion is selected** — there is no "expansion-only, no base" mode in `deep_dive`. The checkbox UI only ever adds expansions on top of a selected base; it cannot select an expansion without its base. This is a deliberate simplification being called out explicitly for approval, not an oversight.

## Validation

| Condition | Result |
|---|---|
| `mode=deep_dive`, `game` only, no `expansions` | Identical behavior to today (backward compatible) |
| `mode=deep_dive`, `game` + 1 valid expansion slug | Combined context: base + one expansion block |
| `mode=deep_dive`, `game` + several valid expansion slugs | Combined context: base + one block per expansion, in request order |
| Any `expansions` entry fails slug regex | `sseError`, no DeepSeek call |
| `expansions.length > 10` | `sseError`, no DeepSeek call |
| Expansion slug valid but has no KV content at all | That expansion's block is omitted from context; base context still used |
| Expansion referenced but its `base_game_slug` doesn't match `game` (mismatched combo from a stale/tampered client) | Not validated server-side in v1 — the Worker trusts the client-selected combo since `chat.html` only ever offers a base's own expansions. Documented as a known simplification, not a security boundary (catalog data isn't sensitive). |

## Testing

- `mybgg-wiki/tests/test_build_catalog.py`: expansion nests correctly under its base's `"expansions"`; expansion still present in the flat top-level list; base game with no expansions gets `"expansions": []`; orphan expansion (base not in wiki) doesn't crash the build and still appears flat.
- `mybgg/worker/`: introduce **vitest** (new dev dependency + minimal config). New test file covers the extracted `buildDeepDiveContext`-style pure function: base-only, base + one expansion, base + multiple expansions, expansion with all-empty sections omitted, combined `gameName` formatting. No KV/network mocking needed since the function takes already-fetched strings.
- `chat.html` / UI: no automated tests today (none exist for this file); verified manually — select a base with expansions, check none/one/several, confirm mode-bar and opening message reflect the combo, confirm request payload includes `expansions`.

## Out of scope

- Automatic combo selection via LLM tool-calling from the discovery chat (would require function-calling infrastructure that doesn't exist in the Worker today).
- Extending `/api/debug/context` to accept `expansions`.
- Fixing the pre-existing gap where `categories` and `playing_time` are never written to frontmatter (`wiki_writer.py`'s `_build_frontmatter` omits them) — unrelated to expansions, left as-is for both base games and expansions.

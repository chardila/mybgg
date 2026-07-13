# README-CHAT — Chat Feature & Content Pipeline

Technical reference for the **Chat** feature of mybgg and the full pipeline that feeds
it (game import, wiki generation, per-section refresh), as of 2026-07-13. Intended as a
guide to understand what exists today, and as a rebuild guide if any part of it needs
to be stood up from scratch (new Cloudflare Worker, new API keys, new wiki repo, etc).

---

## 1. The two-repository split: `mybgg` and `mybgg-wiki`

This feature spans **two separate GitHub repositories**:

| Repo | Contains | Role |
|---|---|---|
| **`chardila/mybgg`** (this repo) | Site code (`index.html`, `chat.html`), the Cloudflare Worker (`worker/`), and all the Python **compiler** scripts (`scripts/compiler/`) that generate wiki content | "Code" — the programs that produce and serve content |
| **`chardila/mybgg-wiki`** (separate repo, not checked out here) | The actual generated content: one folder per game (`games/{slug}/index.md`, `rules.md`, `setup.md`, `teaching.md`, `faq.md`, `glossary.md`) plus `mechanics/{Mechanic Name}.md` cross-reference pages | "Content" — a plain Markdown vault, also usable as an Obsidian vault |

Nothing in `mybgg-wiki` is checked into this repo. The two are wired together only
through GitHub Actions workflows defined **in this repo** (`.github/workflows/`) that:

1. Check out `mybgg` (code) at the workflow's default path.
2. Check out `mybgg-wiki` (content) into a `wiki/` subdirectory, authenticating with
   the `WIKI_GITHUB_TOKEN` secret (a PAT with `repo` scope on `mybgg-wiki`).
3. Run a Python compiler script from `mybgg`, passing `--wiki_path wiki`.
4. The compiler script itself `git commit` + `git push`es directly into the
   `mybgg-wiki` checkout (see `wiki_writer.py`, §3.5) — the workflow doesn't do a
   separate "upload" step, the push happens inside the Python process.

**What is *not* in this repo**: the mechanism that takes the Markdown content from
`mybgg-wiki` and syncs it into the Cloudflare KV namespace (`WIKI`) that the chat
Worker reads from at request time. That sync (referred to elsewhere as
`sync-to-kv.yml`) lives as a workflow **inside the `mybgg-wiki` repo itself**, not
here. If rebuilding this system from scratch, that KV-sync workflow needs to be
recreated in (or ported into) `mybgg-wiki`, pointed at the same `WIKI` KV namespace ID
used by `worker/wrangler.toml`. Known past bugs in that sync (documented only in this
assistant's session memory, not in either repo): it must run `wrangler kv ... --remote`
(a local-only push looks like it worked but silently never reaches production KV), and
it must slugify game names consistently with `_to_slug()` in `bgg_fetcher.py` — that
function does **not** strip accents or `ñ` (Python's `\w` is Unicode-aware), so a sync
step that re-derives slugs differently (e.g. stripping diacritics) will orphan KV keys.

Also outside this repo: `coleccion_cardila_bgg_rules_full.csv` and `faltantes.csv`
(both present at the repo root, tracked/untracked working files) are the input/output
bookkeeping for bulk-importing the user's whole collection — see `bulk_import.py` in
§3.4.

---

## 2. Chat feature

### 2.1 What it does

A conversational assistant embedded in the site, with three modes:

1. **Discovery** — default mode. The user describes what they want to play (player
   count, time, weight, mechanics) and the assistant recommends games from the user's
   own catalog, actively factoring in owned expansions and each game's `numplays` (so
   it can nudge toward under-played games without ruling out a heavily-played one that's
   clearly the best fit). If the question needs information not in the catalog
   (evaluating a new game or expansion to buy), the assistant can search BoardGameGeek
   live via tools.
2. **Deep dive** — the user picks a game (and optionally its expansions) from the "game
   night" dropdown. The assistant answers rules questions using that game's full wiki
   entry (rules, setup, FAQ, glossary), explicitly citing whether an answer comes from
   the wiki or from the model's general knowledge. It can also search BGG's forums live
   for house rules, fan variants, or unofficial solo modes not covered in the wiki.
3. **Teach** — a deep-dive variant for teaching the game to someone who has never
   played (a child, or an adult with no board-gaming background). The assistant
   proactively walks the learner through a fixed sequence: 5-minute explanation → teach
   order item-by-item (waiting for confirmation between items) → first-round walkthrough
   → common beginner mistakes, without waiting to be asked.

Both Spanish and English are supported (ES/EN toggle in the UI); every system prompt is
duplicated in both languages.

### 2.2 Architecture

```
┌─────────────────┐     HTTPS (same origin, bgg.cardila.com)
│   chat.html      │ ──────────────────────────────────────────┐
│ (GitHub Pages)   │                                            │
└─────────────────┘                                            ▼
                                                    ┌───────────────────────┐
                                                    │  Cloudflare Worker      │
                                                    │  "mybgg-chat"           │
                                                    │  (worker/src/index.js)  │
                                                    └───────────────────────┘
                                                       │        │        │
                                          ┌────────────┘        │        └───────────┐
                                          ▼                     ▼                    ▼
                                 KV "WIKI" (catalog      Google Gemini API   DeepSeek API
                                 + per-game wiki           (tool-calling)   (final synthesis)
                                 content, synced                  │
                                 from mybgg-wiki)                  ▼
                                                          BoardGameGeek XML API2
                                                          (bggTools.js, live)
```

- **Frontend**: `chat.html` — a single static HTML/CSS/JS file, no build step, served
  by GitHub Pages alongside the rest of the site (custom domain `bgg.cardila.com`, see
  `CNAME`). It calls the Worker on the same origin under `/api/*`.
- **Backend**: an independent Cloudflare Worker (`worker/`), deployed separately with
  Wrangler. It exposes the `/api/*` routes and orchestrates two LLMs plus the public
  BGG API.
- **Data**: the user's catalog and every game's wiki content live in a Cloudflare KV
  namespace called `WIKI`. That content is generated by the import pipeline described
  in §3 (which lives in this repo but pushes into `mybgg-wiki`), then synced into KV by
  a workflow that lives in `mybgg-wiki` (§1) — the chat Worker only ever *reads* KV, it
  never writes wiki content.

### 2.3 Why two LLMs (hybrid architecture)

Full cost analysis in `analisis_arquitectura_chat.md` (repo root). Summary:

- **Gemini** (`gemini-3.1-flash-lite`, via Google's OpenAI-compatible endpoint) does the
  tool-calling: decides whether it needs to look something up on BGG and with what
  parameters. It's reliable at structured tool calls; DeepSeek is not, in this setup
  (see the DSML leak bug in §2.6). Called with `reasoning_effort: 'minimal'` to keep
  cost/latency down.
- **DeepSeek** (`deepseek-v4-flash`) writes the final answer once all context (catalog,
  wiki, tool results) has been assembled. It is drastically cheaper than Gemini for
  this part (which carries the most tokens), and its Spanish prose quality is better.

This split is cheaper than resolving everything with a single model for tool-using
queries (see the cost simulation in `analisis_arquitectura_chat.md`), and identical in
cost for simple queries that never call a tool.

### 2.4 Request flow

Endpoint: `POST /api/chat` — implemented in `handleChat()` (`worker/src/index.js`).

**Request body:**

```jsonc
{
  "message": "user's text",
  "history": [ /* [{role, content}, ...] — trimmed to the last 20 messages */ ],
  "mode": "discovery" | "deep_dive" | "teach",
  "game": "base-game-slug",           // required for deep_dive/teach
  "expansions": ["exp-slug-1", "..."], // optional, max 10, deep_dive/teach only
  "language": "es" | "en"
}
```

All slugs are validated against `/^[a-z0-9-]+$/` before touching KV.

**Rate limiting**: `checkRateLimit()` (`worker/src/rateLimiter.js`) — fixed 60s window,
max 20 requests per IP (`CF-Connecting-IP`), counter stored in the same `WIKI` KV under
`ratelimit:chat:{ip}:{windowStart}`. Over the limit → 429 via SSE with a localized error.

**Context construction (system prompt)**:
- *discovery*: reads `catalog` from KV, parses it (`parseCatalog`), and "minimizes" it
  (`minimizeGame`) — keeping only `name, players, weight, mechanics, categories,
  status, numplays` (plus `rank` and nested `expansions` for the base game), dropping
  irrelevant fields (`source`, `pdf_url`, `bgg_rank`, etc.) to save tokens. The
  minimized catalog is injected as JSON at the end of the system prompt.
- *deep_dive / teach*: reads the 5 sections (`index`, `rules`, `teaching`, `faq`,
  `glossary`) from KV for the base game and every selected expansion
  (`games/{slug}/{section}`), and assembles the context with `buildDeepDiveContext()`
  (`worker/src/deepDiveContext.js`): the base game's sections go in full under
  `## Overview / Rules / Teaching Guide / FAQ / Glossary`; each expansion is added as a
  `## Expansion: {name}` block containing only what that expansion adds/changes (rules
  are not repeated). The game name shown to the model combines base + expansions
  (e.g. "Root (Fan Edition) + Underworld").

**Tool-calling + synthesis loop (`runChatCompletionStream`)**:
1. Up to `MAX_TOOL_ROUNDS = 2` rounds against **Gemini** with BGG tools available
   (`BGG_TOOL_DEFINITIONS`). Each round emits an SSE `thinking` status.
   - If Gemini doesn't request a tool in round 1, that answer streams straight to the
     user (never touching DeepSeek) — the fast, cheap path for simple questions.
   - If it does request tools, they're executed (max `MAX_TOOL_CALLS_PER_ROUND = 3` per
     round, in parallel) via `executeBggTool()`, a more specific status is emitted
     (`searching` / `details` / `forum` depending on the tool), and the results are
     appended to the message history as `role: "tool"` turns.
   - If round 2 is reached and Gemini still wants more tools, the loop is cut off
     (`hitToolRoundCap`) and a system note (`noMoreToolsNote`) is appended telling the
     synthesis model no more lookups are available — this stops DeepSeek from trying to
     hallucinate a tool call of its own.
2. **Final synthesis** against **DeepSeek**, with a `writing` status, using the full
   accumulated history (system + catalog/wiki + tool results + user message). Its
   response streams to the frontend token by token.

**Streaming, buffering, and error handling**:
- Each round is called through `attemptBufferedRoundWithRetry`, which buffers all
  tokens of that round in memory before deciding what to do (nothing is forwarded to
  the user until the round finishes), retrying **once** if:
  - `isIncompleteStream`: the upstream stream ended without ever sending a
    `finish_reason` (observed in production: intermittent Gemini 503s cutting the
    stream short).
  - (DeepSeek round only) `looksLikeLeakedToolCall`: DeepSeek sometimes leaks a failed
    tool-call attempt as raw `"DSML"` text instead of structuring it — a known DeepSeek
    bug, not fixable on this side, mitigated with a retry.
  - If the retry hits the same problem again, a localized fallback message
    (`fallbackMessage`) is returned instead of showing the user garbage.
- The wire protocol to the frontend is **Server-Sent Events** (`text/event-stream`),
  three event shapes, each as `data: {...}\n\n`:
  - `{"status": "thinking"|"searching"|"details"|"forum"|"writing"}` — progress
    indicator.
  - `{"token": "..."}` — a text fragment of the answer.
  - `{"error": "..."}` — an error message to display verbatim.
  - Always closed with `data: [DONE]\n\n`.

### 2.5 Frontend (`chat.html`)

- No external dependencies, no build step: plain HTML/CSS/JS in one file.
- Keeps the conversation `history` in browser memory (no server-side persistence) and
  sends it back on every request.
- Parses SSE manually via `fetch` + `ReadableStream`, updating a hand-rolled markdown
  renderer (`renderMarkdown`: headings, bold, italics, inline code, lists, tables) as
  tokens arrive, with a blinking cursor (`▋`) while streaming.
  - **Security note**: `renderMarkdown` escapes `& < >` in the raw text *before*
    applying markdown rules, so HTML injected by the LLM can't execute `<script>` or
    arbitrary tags.
- `status` events swap in an emoji label (💭 Thinking... / 🔍 Searching BGG... /
  📖 Looking up game details... / 💬 Checking forums... / ✍️ Writing the answer...),
  localized ES/EN.
- If no token arrives within 8s, a "this is taking longer than usual (Ns)..." note
  appears and updates every second (`stallInterval`), without cancelling the request.
- The "game night" dropdown is populated from `GET /api/games`; picking a game with
  expansions reveals checkboxes to select them, plus two buttons: "Start" (deep dive)
  or "Teach me" (teach mode). A "back to discovery" link resets all state.
- `WORKER_URL = ''` — the frontend assumes the Worker is mounted on the **same origin**
  (`bgg.cardila.com/api/*`), see §5.6 on routing.

### 2.6 Known issues / technical debt

- **DeepSeek DSML leak**: `deepseek-v4-flash` sometimes leaks a tool-call attempt as
  raw `"DSML"` text during the synthesis round (a DeepSeek bug, not this codebase's).
  Mitigated with detection (`looksLikeLeakedToolCall`) + single retry + fallback error
  message if it persists.
- **Intermittent stream cutoffs**: observed in production, Gemini returning
  intermittent 503s that cut the stream short with no `finish_reason` (a 3-token
  response, then nothing). Mitigated the same way (`isIncompleteStream`).
- The `bgg.cardila.com/api/*` → Worker route lives outside this repo (Cloudflare
  dashboard), so there's no single versioned place documenting it — see §5.6.

### 2.7 Endpoints

All CORS-scoped to `https://bgg.cardila.com` and `http://localhost*`
(`getCorsHeaders`).

| Method | Path | What it does |
|---|---|---|
| `OPTIONS` | `*` | CORS preflight, 204. |
| `GET` | `/api/health` | Health check, returns `ok`. |
| `GET` | `/api/games` | Returns the full catalog (`catalog` from KV) as-is, JSON. Used to populate the game dropdown. |
| `GET` | `/api/debug/context?game=<slug>` | Debug: byte size of the catalog and of each wiki section for a game (useful for gauging how much context is sent to the LLM). |
| `POST` | `/api/chat` | Main endpoint, described above. Returns an SSE stream. |
| anything else | — | 404 `not found`. |

### 2.8 Chat worker tests

`worker/test/` (Vitest, `npm test` from `worker/`):

| File | Covers |
|---|---|
| `runChatCompletion.test.js` | Full `handleChat` flow / end-to-end SSE streaming. |
| `deepseekStream.test.js` | DeepSeek SSE stream parsing (`parseDeepSeekStream`). |
| `bggTools.test.js` | All 4 BGG tools (`bgg_search_game`, `bgg_get_game_details`, `bgg_search_forum`, `bgg_get_thread`), including `[quote]`/`[q]` stripping and post truncation. |
| `deepDiveContext.test.js` | Base game + expansions context assembly. |
| `teachMode.test.js` | End-to-end teach mode. |
| `minimizeGame.test.js` | Catalog minimization for discovery mode. |
| `rateLimiter.test.js` | Fixed-window rate limiting over KV. |
| `statusForToolCalls.test.js` | Mapping tool calls to status labels (`searching`/`details`/`forum`). |
| `sseHelpers.js` | Shared helpers to fake SSE responses in tests. |

---

## 3. Content pipeline: `scripts/compiler/`

This is the machinery that turns a BGG game ID (+ optionally a rulebook PDF) into the
Markdown wiki entry that the chat's deep-dive/teach modes read at runtime. It runs
**locally or in GitHub Actions**, never inside the Cloudflare Worker.

### 3.1 `add_game.py` — import a single game

Entry point: `python scripts/compiler/add_game.py --bgg_id <id> --status <status> --wiki_path <path> [--pdf_url <url>] [--edition <label>]`.

1. Fetches BGG metadata for `bgg_id` via `bgg_fetcher.fetch_game()`.
2. Resolves an edition label (`--edition`, or falls back to the BGG publication year)
   and appends it to the slug (e.g. `root-2018`).
3. If the game is an expansion, looks up its base game inside the wiki
   (`find_base_game_in_wiki()`, by scanning `games/*/index.md` frontmatter for a
   matching `bgg_id`) and aborts if the base game hasn't been imported yet.
4. If `--pdf_url` is given: downloads the PDF (`pdf_fetcher.fetch_pdf`) and extracts
   its text (`pdf_parser.extract_text`, via `pdfplumber`) to use as the authoritative
   rulebook source. If no `--pdf_url`, `--edition` is mandatory and content is
   generated from the model's general knowledge instead (marked with a warning banner
   in the output, `_llm_only_warning`).
5. Compiles all wiki sections via `llm_compiler.compile_game()` (§3.2).
6. For any of the game's mechanics that don't already have a `mechanics/{name}.md`
   page, generates a short description (`generate_mechanic_description()`) and creates
   or updates that mechanic's cross-reference page (`sync_mechanic_pages()` /
   `mechanic_page_exists()`, in `wiki_writer.py`) — this is what builds the mechanics
   graph mentioned in `analisis_generacion_wiki.md` §4.
7. Writes everything to `{wiki_path}/games/{slug}/` and commits + pushes
   (`write_game()`, §3.5).

Used directly by `.github/workflows/import-game.yml` (manual `workflow_dispatch`, one
game at a time) and indirectly by `bulk_import.py` (§3.4, one subprocess call per row).

### 3.2 `llm_compiler.py` — the actual content generation

`compile_game(game_data, rulebook_text, pdf_bytes, deepseek_provider, gemini_provider, only_sections=None)`
generates each of the six sections (`index`, `setup`, `rules`, `teaching`, `faq`,
`glossary`, in that order — `SECTION_ORDER`) and returns `(sections, failures)`; a
section failing doesn't abort the others, it's just recorded in `failures`. All prompts
instruct the model to use `[[Wiki Link]]` syntax for cross-references, write in
English (except `teaching`, which is deliberately entirely in Spanish, written directly
to a beginner), and never include YAML frontmatter (frontmatter is added separately by
`wiki_writer.py`).

- **`index`**: 2-3 paragraph overview + a "Key Info" metadata table + mechanic links.
- **`setup`**: components list + numbered setup steps + player-count variations. If a
  PDF is available, generated **multimodally** by Gemini (`_compile_setup`) — Gemini
  can "see" the PDF directly (component photos, setup diagrams) and is instructed to
  transcribe them into structured Markdown steps rather than saying "an image shows...".
  Without a PDF, falls back to plain DeepSeek text generation from general knowledge.
- **`rules`** (the most involved one, `_compile_rules`): if a PDF is available, first
  runs an **outline pass** — `plan_rules_outline()` sends the extracted rulebook text
  to Gemini asking it to identify page ranges containing core rules content (turn
  structure, actions, combat, scoring — explicitly excluding setup/FAQ/glossary
  material) and return up to `MAX_RULES_CHAPTERS = 8` chapters as strict JSON
  `[{"titulo": ..., "paginas": [start, end]}]`. Malformed/out-of-range results are
  discarded per-chapter; if there are more than 8 valid chapters, adjacent ones are
  merged (`_merge_chapters_to_cap`, always merging the pair with the smallest
  resulting page gap) until the cap is met. Then, for each chapter, `pdf_slicer.slice_pages()`
  extracts just that page range as a standalone PDF and Gemini is asked to write
  *only* that chapter's Markdown (`_rules_chapter_prompt`) — this keeps each chapter
  under Gemini's per-call output token limit without truncating detail, unlike a
  single call over the whole rulebook. If the outline pass fails entirely (or there's
  no PDF), falls back to one single DeepSeek text-only call over the full rulebook
  text (or general knowledge, if no PDF at all).
- **`teaching`**: the source for the chat's "teach" mode (§2). Always written directly
  addressed to a total beginner, second person, jargon explained on first use. Fixed
  section order: *Explicación de 5 minutos*, *Orden de enseñanza* (numbered, each item
  ready to be read aloud as-is), *Primera ronda paso a paso*, *Reglas para más
  adelante* (deliberately meant to be withheld unless asked), *Errores comunes de
  principiante*, *Detalles que se olvidan*.
- **`faq`**: Q&A pairs covering frequent situations, commonly-misunderstood rule
  interactions, and rulebook edge cases.
- **`glossary`**: alphabetical entries, English definition + Spanish translation for
  every game-specific term.

Expansions get an extra instruction block (`_expansion_block`) telling the model to
describe *only* what the expansion adds/changes and assume the reader already knows
the base game — this is what lets `deepDiveContext.js` on the Worker side present
expansion sections as deltas instead of restating the whole ruleset.

`generate_mechanic_description(name, provider)` is the 1-2 sentence generator used for
new `mechanics/*.md` pages (via DeepSeek).

### 3.3 `llm_provider.py` — the two LLM clients used by the compiler

- **`DeepSeekProvider`** — thin wrapper over the official `openai` Python SDK pointed
  at `https://api.deepseek.com`, model `deepseek-chat`. Plain `generate(system, prompt)`.
- **`GeminiProvider`** — raw `requests` call to Gemini's native
  `generateContent` REST endpoint (not the OpenAI-compatible one the *chat Worker*
  uses — the compiler talks to Gemini directly), model `gemini-3.1-flash-lite`.
  `generate()` is text-only; `generate_multimodal(system, prompt, pdf_bytes)`
  base64-encodes the PDF bytes and attaches them as `inline_data`, which is what
  lets `setup` and the per-chapter `rules` compilation "see" the actual manual pages.

Both implement the same `LLMProvider` ABC (`generate(system, prompt) -> str`), so
`llm_compiler.py` can treat them interchangeably wherever it doesn't specifically need
multimodal input.

### 3.4 `bulk_import.py` — import a whole CSV of games in one run

Entry point: `python scripts/compiler/bulk_import.py --csv <path> --wiki_path <path> --status <status> [--limit N] [--only id1,id2,...]`.

- Reads a CSV with (at least) `id`, `name`, `type`, `URL` columns — `coleccion_cardila_bgg_rules_full.csv`
  at the repo root is the working copy of the user's full collection with a rulebook
  PDF URL per row where one was found.
- Orders rows so base games are processed before expansions (`type == "expansion"`
  sorts last) — this matters because `add_game.py` requires a base game to already
  exist in the wiki before importing its expansion.
- Skips any `bgg_id` that's already present in the wiki (`already_in_wiki()`, same
  frontmatter scan as `find_base_game_in_wiki()`), so the script is safe to re-run
  against a partially-completed CSV.
- For each remaining row, shells out to `add_game.py` as a **subprocess** (one Python
  process per game, so one game's crash never takes down the whole batch) and records
  `ok` / `failed` (with the last 500 chars of stderr) per row.
- Writes a Markdown summary table (bgg_id / name / outcome / detail) to stdout and, if
  running in GitHub Actions, appends it to `$GITHUB_STEP_SUMMARY` so the run summary is
  visible directly in the Actions UI.
- `faltantes.csv` at the repo root is the tracked list of rows that failed a bulk-import
  attempt (a filtered/derived view of the CSV) — used to re-drive `--only` on a later
  targeted retry once whatever caused the failures (usually a bad/expired PDF URL) is
  fixed.

Used by `.github/workflows/bulk-import-games.yml`.

### 3.5 `wiki_writer.py` — filesystem + git layer

- **`write_game()`** — used by `add_game.py` for a brand-new import. Builds the
  frontmatter (`_build_frontmatter`: `bgg_id`, `name`, `slug`, `status`, `source`,
  `edition`, `yearpublished`, `pdf_url` if any, `base_game_bgg_id`/`base_game_slug` if
  an expansion, `players`, `weight`, `rank`, `mechanics`, `imported` date), writes
  `index.md` (frontmatter + optional `_llm_only_warning` banner + the generated
  overview — preserving any pre-existing `## Expansions` list so re-importing the base
  game doesn't wipe out expansions added after it), writes the other five section
  files, and if this game is an expansion, appends a link to it under `##
  Expansions` in the base game's `index.md` (`_update_base_game_expansions`). Finally
  stages everything (`games/{slug}/`, the base game's `index.md` if touched,
  `mechanics/` if it exists) and commits+pushes if there's anything staged
  (`_has_staged_changes` / `_git_commit_and_push`) — a no-op re-import (identical
  content) is a deliberate no-op commit, not an empty commit.
- **`update_sections()`** — used by `refresh_sections.py` (§3.6) to regenerate *specific*
  section files for an already-imported game without touching frontmatter or the
  expansions list. Writes only the requested section files, commits with message
  `refresh: regenerate {sections} for {game}`, and pushes — again a no-op if nothing
  actually changed.
- **`sync_mechanic_pages()` / `mechanic_page_exists()`** — the mechanics cross-reference
  graph: one Markdown page per mechanic under `mechanics/{name}.md`, each listing every
  game in the catalog that uses it as a `[[wikilink]]` bullet. New games append their
  entry to an existing mechanic page; brand-new mechanics get a page created with the
  LLM-generated description from `generate_mechanic_description()`.

### 3.6 `refresh_sections.py` — regenerate specific sections for an existing game

Entry point: `python scripts/compiler/refresh_sections.py --slug <slug> --sections <comma-separated> --wiki_path <path>`.

The tool behind "I want to regenerate just `teaching.md` (or `faq,glossary`, etc.) for
a game that's already in the wiki" without re-running the whole import. `--sections`
accepts any of `setup, rules, teaching, faq, glossary` — **`index` is deliberately
rejected** (`VALID_SECTIONS = SECTION_ORDER - {"index"}`), because `index.md` carries
frontmatter and the optional `## Expansions` block rather than a plain section body;
`update_sections()` has no special-casing for that, so allowing it here would let a
refresh silently overwrite and push a corrupted `index.md`.

1. Reads the existing `index.md` frontmatter for that slug (`_read_existing_game`) to
   recover `bgg_id`, `edition`, `pdf_url`, and `base_game_slug`.
2. Re-fetches fresh BGG metadata for that `bgg_id` (so weight/rank/mechanics reflect
   BGG's current data even though the slug/edition stay fixed).
3. Re-downloads the stored `pdf_url` if present. **Not currently an error if that
   download fails** — some stored PDF URLs are ephemeral (BGG-hosted files served from
   pre-signed links that expire), so a broken URL falls back to general-knowledge
   generation for this refresh instead of aborting, same as a game with no PDF at all
   (this was a deliberate fix — see `analysis of DSML`/git log commit
   "fix: fall back to general knowledge when a stored PDF URL fails").
4. Calls `compile_game(..., only_sections=sections)` to regenerate just the requested
   sections, then `update_sections()` to write + commit + push them.

This script is **not wired into any GitHub Actions workflow yet** — it's invoked
manually/locally (wiki_path pointing at a local clone of `mybgg-wiki`) when a specific
section needs a one-off regeneration, e.g. after improving a prompt in
`llm_compiler.py`. A full backfill of all games' `teaching.md` to the newer prompt
format was run this way across the whole existing wiki.

### 3.7 PDF handling helpers

- **`pdf_fetcher.py`** — `fetch_pdf(url)`: plain `requests.get`, returns raw bytes.
- **`pdf_parser.py`** — `extract_text(pdf_bytes)`: page-by-page text extraction via
  `pdfplumber`, joined with blank lines. This is what's fed to the outline-planning
  step and to text-only fallback generation; it is *not* used when Gemini reads the PDF
  multimodally (that path sends the raw PDF bytes instead).
- **`pdf_slicer.py`** — `slice_pages(pdf_bytes, [(start, end), ...])` (via `pypdf`,
  1-indexed inclusive ranges, clamped to the real page count) and `count_pages(pdf_bytes)`.
  Used to cut out just the pages belonging to one rules chapter before sending them to
  Gemini multimodally.

### 3.8 `bgg_fetcher.py` — BGG metadata for the compiler

`fetch_game(bgg_id, token)` wraps `gamecache.bgg_client.BGGClient.game_list()` and
reshapes the result into what the compiler needs: `id`, `name`, `slug` (via
`_to_slug()`), `description`, `mechanics`, `categories`, `players` (a `"min-max"`
string, or just the number if min==max), `min_players`/`max_players`, `weight`, `rank`,
`playing_time`, `yearpublished`, and — if this game is itself an expansion —
`is_expansion` + `base_game_id` (BGG's own "inbound expansion" link back to its base
game). `_to_slug()` lowercases, strips anything that isn't a word character/space/dash,
and collapses whitespace/underscores to single dashes — note it does **not** strip
accents or `ñ` (Unicode `\w` keeps them), so a game named e.g. "Añón" would slugify to
`añón`, not `anon`; keep this in mind if a downstream consumer (like a KV-sync step)
re-derives slugs with different normalization.

---

## 4. Collection indexing: `scripts/gamecache/` + top-level scripts

This is a **separate, older pipeline**, inherited from the upstream GameCache template
this repo was forked from — unrelated to the LLM wiki/chat feature, but part of the
same repo and worth documenting for completeness. It builds the searchable SQLite
database (`gamecache.sqlite.gz`) that powers the main collection browser
(`index.html`), by downloading the user's collection from BGG.

### 4.1 `download_and_index.py` — the main entry point

`python scripts/download_and_index.py [--cache_bgg] [--no_upload] [--debug] [--config config.ini]`

1. Reads `config.ini` (BGG username, extra collection params, GitHub repo/release
   settings) via `gamecache.config.parse_config_file` / `create_nested_config`.
2. Downloads the user's BGG collection (`gamecache.downloader.Downloader.collection()`),
   deduplicates by game ID.
3. Builds a local SQLite database from the collection
   (`gamecache.sqlite_indexer.SqliteIndexer.add_objects()`), gzips it to
   `gamecache.sqlite.gz`, and deletes the uncompressed file.
4. Unless `--no_upload`, uploads that gzip as a GitHub Release asset
   (`gamecache.github_integration.setup_github_integration` /
   `GitHubReleaseManager.upload_snapshot`) — this is the file `app-sqlite.js` (client
   side, in `index.html`) downloads at page-load time to power search.

Run hourly by `.github/workflows/index.yml` (§5.1) and manually for local development
(see root `README.md` for the local dev walkthrough).

### 4.2 `scripts/gamecache/` module reference

| File | Responsibility |
|---|---|
| `bgg_client.py` | `BGGClient` — raw XML API v2 client: `collection()`, `plays()`, `game_list()`; retries and an optional local SQLite response cache (`CacheBackendSqlite`) when `--cache_bgg` is used. |
| `downloader.py` | `Downloader` — thin orchestration layer over `BGGClient.collection()`, adding play counts (`numplays`) per game. |
| `models.py` | `BoardGame` — normalizes raw BGG collection/thing data into the fields the indexers consume (`calc_num_players`, `calc_playing_time`, `calc_min_age`, `calc_rank`, `calc_usersrated`, `calc_numowned`, `calc_rating`, `calc_weight`, `todict()`). |
| `sqlite_indexer.py` | `SqliteIndexer` — builds the actual `gamecache.sqlite` schema and rows (current indexing backend). |
| `indexer.py` | `Indexer` — an older/alternate Algolia-based indexer (search facets, image fetching, description truncation); kept for reference/compat, not the primary path invoked by `download_and_index.py` today (which uses `sqlite_indexer.py`). |
| `github_integration.py` | `GitHubAuth` (device-flow OAuth for interactive local runs) + `GitHubReleaseManager` (`upload_snapshot`, create-or-update a GitHub Release and (re)upload the `gamecache.sqlite.gz` asset) — this is the "no human to log in" problem the root `README.md` explains, solved via a PAT (`GAMECACHE_GITHUB_TOKEN`) in CI instead of the device flow. |
| `http_client.py` | Shared HTTP helpers: `make_http_request`/`make_http_post`, an `HttpSession` wrapper, and `CachedHttpClient` (disk-cached GETs, used by `--cache_bgg`). |
| `config.py` | `parse_config_file` / `create_nested_config` — reads `config.ini` (flat key=value) into the nested dict shape the rest of the module expects. |

### 4.3 Other top-level `scripts/*.py`

| Script | Purpose |
|---|---|
| `setup_bgg_token.py` | Interactive one-time setup: walks the user through generating a BGG XML API v2 bearer token manually on BGG's site, validates it against the real API, and saves it to a git-ignored `.env` file as `GAMECACHE_BGG_TOKEN`. (A prior version of this script tried to auto-generate the token via a Cloudflare Worker that turned out to return fake tokens BGG always rejects — manual generation on BGG's site is the only supported path today, see root `README.md`.) |
| `enable_hourly_updates.py` | One-time convenience script: reads a locally-cached GitHub device-flow token and pushes it into the repo's GitHub Actions secrets via the API (encrypting it with the repo's public key, `encrypt_secret`), so `index.yml`'s hourly schedule has what it needs without the user manually creating secrets in the GitHub UI. |
| `validate_setup.py` | Pre-flight checklist run before the main indexing script: validates `config.ini`, the configured BGG username, and that required Python dependencies are importable. |
| `check_website.py` | Simple smoke test that the deployed GitHub Pages site is reachable and serving what's expected. |
| `setup_logging.py` | One-liner: quiets noisy third-party loggers (e.g. `PIL`) to `WARNING` so script output stays readable. |

---

## 5. GitHub Actions workflows (`.github/workflows/`)

| Workflow | Trigger | What it runs |
|---|---|---|
| `index.yml` | Hourly cron (`0 * * * *`) + manual | `scripts/download_and_index.py --debug` — refreshes `gamecache.sqlite.gz` from the user's live BGG collection and re-uploads it as a GitHub Release asset. Self-disables (skips with a notice) if `GAMECACHE_GITHUB_TOKEN` (or the deprecated `MYBGG_GITHUB_TOKEN` fallback) isn't set as a secret. |
| `import-game.yml` | Manual (`workflow_dispatch`, inputs: `bgg_id`, `pdf_url`, `edition`, `status`) | Checks out both `mybgg` and `mybgg-wiki` (via `WIKI_GITHUB_TOKEN`), then runs `scripts/compiler/add_game.py` — imports **one** game into the wiki. |
| `bulk-import-games.yml` | Manual (`workflow_dispatch`, inputs: `csv_path` default `coleccion_cardila_bgg_rules_full.csv`, `status`, `limit`, `only`) | Same two-repo checkout, then `scripts/compiler/bulk_import.py` — imports every not-yet-imported row from the CSV, with a Markdown summary written to the Actions run summary. |
| `pages.yml` | Push to `master` + manual | Deploys the static site (this whole repo, path `.`) to GitHub Pages. **Does not touch the Cloudflare Worker** — see the deployment note in §6.5. |
| `keepalive.yml` | Cron every ~2 months (Jan/Mar/May/Jul/Sep/Nov) + manual | An empty commit, purely to keep the repository "active" for GitHub's scheduled-workflow-disabling policy (GitHub disables cron workflows on repos with no activity for 60 days). Unrelated to chat/content, listed here for completeness. |

Secrets referenced across these workflows: `GAMECACHE_BGG_TOKEN` (BGG API auth),
`GAMECACHE_GITHUB_TOKEN` / deprecated `MYBGG_GITHUB_TOKEN` (release upload permissions
on *this* repo), `WIKI_GITHUB_TOKEN` (checkout+push permissions on `mybgg-wiki`),
`DEEPSEEK_API_KEY`, `GEMINI_API_KEY` (compiler LLM calls — same two providers as the
chat Worker, but called directly from Python here, not proxied through the Worker).

---

## 6. Rebuilding from scratch

### 6.1 Prerequisites

- A Cloudflare account with Workers + KV enabled.
- A **Google Gemini** API key (OpenAI-compatible endpoint
  `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` for the
  chat Worker; native `generateContent` endpoint for the compiler — same key works for
  both), model `gemini-3.1-flash-lite`.
- A **DeepSeek** API key (`https://api.deepseek.com`), models `deepseek-v4-flash` (chat
  Worker) / `deepseek-chat` (compiler).
- A BGG API token (`GAMECACHE_BGG_TOKEN`) — generate manually via
  `scripts/setup_bgg_token.py` (see root `README.md`; the old auto-generator Worker is
  permanently broken and unrelated to this repo).
- The separate `mybgg-wiki` repository (or a fresh empty repo to serve as one), plus a
  GitHub PAT with `repo` scope on it (`WIKI_GITHUB_TOKEN`), to run the import workflows.

### 6.2 Create the KV namespace

```bash
cd worker
npx wrangler kv namespace create WIKI
```

Copy the returned `id` into `worker/wrangler.toml` under `[[kv_namespaces]]` (already
present there for the current namespace, `binding = "WIKI"`).

### 6.3 Populate KV content

- Key `catalog` → the full JSON array of the user's catalog (same shape produced by
  the `gamecache` indexing pipeline, §4).
- Per game: keys `games/{slug}/index`, `games/{slug}/rules`, `games/{slug}/teaching`,
  `games/{slug}/faq`, `games/{slug}/glossary` (Markdown, with frontmatter including at
  least `name:` and optionally `edition:` — used by `deepDiveContext.js` to build the
  name shown to the model).
- In practice this is populated by: (1) running the import pipeline in §3 to produce
  Markdown in a `mybgg-wiki` clone, then (2) a KV-sync workflow living **in that
  `mybgg-wiki` repo** (not this one — see §1) pushing that Markdown into KV. Validate
  slugs match `/^[a-z0-9-]+$/` end-to-end (no accents/ñ) to avoid orphaned KV keys.

### 6.4 Configure Worker secrets

```bash
cd worker
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put BGG_TOKEN
```

For local development, create `worker/.dev.vars` (git-ignored):

```
DEEPSEEK_API_KEY=...
BGG_TOKEN=...
GEMINI_API_KEY=...
```

### 6.5 Deploy the Worker

```bash
cd worker
npm install
npm run deploy      # wrangler deploy
```

⚠️ A `git push` to `master` does **not** deploy the Worker — it only triggers
`pages.yml` (static site → GitHub Pages). Any change to `worker/src/*.js` needs a
manual `wrangler deploy` from `worker/`.

### 6.6 Same-domain routing

`chat.html` calls `/api/*` on the same origin (`bgg.cardila.com`), but
`worker/wrangler.toml` defines no `route` — the binding between
`bgg.cardila.com/api/*` and the `mybgg-chat` Worker is configured **outside this repo**,
in the Cloudflare dashboard (Workers Routes) or via DNS+Workers on the `cardila.com`
zone. When recreating this from scratch:
1. Make sure `cardila.com` is on Cloudflare (proxied/orange-clouded) so Cloudflare can
   intercept `bgg.cardila.com` traffic before it reaches GitHub Pages.
2. Add a Route (`bgg.cardila.com/api/*` → Worker `mybgg-chat`) in the dashboard, or add
   `routes = [...]` to `wrangler.toml` if you'd rather manage it as code.
3. Confirm the root `CNAME` file still points to `bgg.cardila.com` for GitHub Pages.

For quick testing, `WORKER_URL` in `chat.html` can instead be pointed at the Worker's
public `*.workers.dev` URL, adjusting `getCorsHeaders()` in `worker/src/index.js` if the
origin changes.

### 6.7 Set up the content pipeline

1. Create/point at a `mybgg-wiki` repository, add a PAT with `repo` scope as
   `WIKI_GITHUB_TOKEN` in this repo's Actions secrets.
2. Add `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `GAMECACHE_BGG_TOKEN` as Actions secrets
   (same values as the Worker's, for the two LLM calls plus BGG auth made directly from
   Python).
3. Run `import-game.yml` for a first game to confirm the whole chain (BGG fetch → PDF
   fetch/parse → Gemini/DeepSeek generation → commit+push into `mybgg-wiki`) works
   end-to-end, then set up the KV-sync workflow in `mybgg-wiki` (§1, §6.3) so that
   content actually reaches the chat Worker.
4. For a full collection: build a CSV (`id, name, type, URL`) and run
   `bulk-import-games.yml`, optionally with `--limit`/`--only` for a small validation
   batch first.

### 6.8 Verify

```bash
curl https://bgg.cardila.com/api/health          # -> "ok"
curl https://bgg.cardila.com/api/games           # -> catalog JSON
curl "https://bgg.cardila.com/api/debug/context?game=<slug>"
```

Then exercise the full chat flow by opening `https://bgg.cardila.com/chat.html` in a
browser.

---

## 7. Key constants (for future tuning)

| Constant | Value | Location |
|---|---|---|
| `MAX_TOOL_CALLS_PER_ROUND` | 3 | `worker/src/index.js` |
| `MAX_TOOL_ROUNDS` | 2 | `worker/src/index.js` |
| Chat history sent to the LLM | last 20 messages | `handleChat()` |
| Rate limit | 20 req/IP/60s | `worker/src/rateLimiter.js` |
| Expansions allowed per request | max 10 | `handleChat()` |
| Forum posts per thread | max 10, 1500 chars each | `worker/src/bggTools.js` |
| Gemini model (chat) | `gemini-3.1-flash-lite`, `reasoning_effort: minimal` | `callGemini()` |
| DeepSeek model (chat) | `deepseek-v4-flash` | `callDeepSeek()` |
| Gemini model (compiler) | `gemini-3.1-flash-lite` | `llm_provider.GeminiProvider` |
| DeepSeek model (compiler) | `deepseek-chat` | `llm_provider.DeepSeekProvider` |
| Max rules chapters (outline pass) | 8 (`MAX_RULES_CHAPTERS`) | `llm_compiler.py` |

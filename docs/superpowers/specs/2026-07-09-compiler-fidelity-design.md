# Compiler Fidelity — Outline Pass + Multimodal Rules/Setup

**Date:** 2026-07-09
**Scope:** Improve the fidelity of `scripts/compiler/` when compiling `rules.md` and `setup.md` from a provided PDF rulebook. Does not touch the chat/Worker layer (already handles KV-based context assembly and prompt caching) or the mechanics/relationship graph (separate future spec).

---

## Problem

The current compiler (`llm_compiler.py`) makes exactly one LLM call per wiki section, using `pdfplumber`-extracted plain text of the *entire* rulebook as context, via `DeepSeekProvider` (text-only). For dense manuals, `rules.md` in particular gets over-summarized: the model has the whole book as input but only one output-token budget to cover turn structure, core mechanics, edge cases, and scoring, so nuance and exceptions get dropped. Additionally, `pdfplumber` only extracts text — diagrams, combat illustrations, and setup photos are invisible to the compiler entirely, even though they often carry rules that aren't restated in prose.

## Non-goals

- Backfilling already-imported games. This only changes behavior for future imports.
- Changing the chat/Worker layer or the wiki's file structure (`index.md`, `setup.md`, `rules.md`, `teaching.md`, `faq.md`, `glossary.md` stay as-is — this only changes *how* `rules.md` and `setup.md` are generated).
- The `llm-only` compilation path (no `--pdf_url` provided) — unaffected by any of this, since there's no PDF to plan or slice.
- A toggle between "old" and "new" compiler behavior. The new flow replaces the current one outright when a PDF is provided.

---

## Architecture

```
--pdf_url provided
        │
        ▼
pdfplumber extracts full text (unchanged — still used for index/teaching/faq/glossary,
                                and as the source text for the outline pass)
        │
        ▼
Outline Pass (Gemini, text-only)
  → asks for a JSON chapter map of the RULES content only (page ranges, max 6-8 chapters)
        │
        ├── succeeds, valid JSON, 1+ chapters
        │       │
        │       ▼
        │   For each chapter: slice PDF to that page range → GeminiProvider.generate_multimodal()
        │       → concatenate chapter Markdown → rules.md
        │
        └── fails (bad JSON, 0 chapters, network/API error)
                │
                ▼
            Single call, full rulebook text, DeepSeekProvider (today's behavior) → rules.md

setup.md: always GeminiProvider.generate_multimodal() with the FULL PDF (no page slicing,
          no dependency on the outline pass — see "Why no setup page-range classification" below)

index.md, teaching.md, faq.md, glossary.md: unchanged — one DeepSeekProvider text call each,
  full rulebook text, same as today
```

### Why only `rules.md` gets chapter-split

Game manuals vary widely in structure and clarity — some have clean tables of contents, others don't. Asking an LLM to classify the *entire* manual into all 6 fixed wiki sections (a 6-way mapping) is fragile precisely because of that diversity: teaching guides, FAQs, and glossaries are synthesized cross-cutting views, not contiguous manual sections, so there's no reliable page range to assign them. Rules content, by contrast, usually *is* identifiable as a contiguous block (even if messy), making it the only section worth the classification risk. `rules.md` is also the section most measurably damaged by output-token ceilings today, so it's where the fidelity gain is concentrated.

### Why no page-range classification for `setup.md`

Extending the outline pass to also identify a "setup" page range would reintroduce the same classification fragility for a single call whose full-manual cost is already low. Sending the entire PDF multimodally for the one `setup` call is simpler, has no misclassification risk, and rulebooks are rarely large enough for this to be a meaningful cost concern for a manual, one-off import.

---

## Components

### `scripts/compiler/llm_provider.py`

Add `GeminiProvider`, implemented via direct REST calls to the Gemini API (`requests`, already a dependency — no new SDK). Two capabilities:

```python
class GeminiProvider:
    def __init__(self, api_key: str, model: str = "gemini-3.1-flash-lite"): ...

    def generate(self, system: str, prompt: str) -> str:
        # text-only call — used by the outline pass

    def generate_multimodal(self, system: str, prompt: str, pdf_bytes: bytes) -> str:
        # PDF bytes sent as inline_data (mime_type application/pdf) alongside the prompt
```

`DeepSeekProvider` is unchanged and continues to serve `index`, `teaching`, `faq`, `glossary`.

### `scripts/compiler/pdf_slicer.py` (new)

```python
def slice_pages(pdf_bytes: bytes, page_ranges: list[tuple[int, int]]) -> bytes:
    # returns a new PDF containing only the given (1-indexed, inclusive) page ranges
```

Implemented with `pypdf` (new dependency — add to `scripts/requirements.in`). `pdfplumber`'s transitive `pypdfium2` dependency is not a good fit here since it's oriented at rendering/reading, not producing a new sliced PDF document.

### `scripts/compiler/llm_compiler.py`

New function:

```python
def plan_rules_outline(rulebook_text: str, provider: GeminiProvider) -> list[dict] | None:
    """
    Returns a list of {"titulo": str, "paginas": [start, end]} dicts (max 6-8 entries),
    or None if the outline pass fails or produces something unusable
    (malformed JSON, empty list, more than 8 chapters after an attempted merge/truncate,
    page ranges that don't parse to valid ints).
    """
```

`compile_game` changes only how `rules` is produced:

```python
outline = plan_rules_outline(rulebook_text, gemini_provider) if rulebook_text else None
if outline:
    chapter_mds = []
    for chapter in outline:
        pdf_slice = slice_pages(pdf_bytes, [tuple(chapter["paginas"])])
        chapter_mds.append(gemini_provider.generate_multimodal(SYSTEM, chapter_prompt(chapter, game_data), pdf_slice))
    sections["rules"] = "\n\n".join(chapter_mds)
else:
    sections["rules"] = deepseek_provider.generate(SYSTEM, rules_prompt(game_data, rulebook_text))  # today's path
```

`setup` changes to:

```python
sections["setup"] = gemini_provider.generate_multimodal(SYSTEM, setup_prompt(game_data), pdf_bytes)
```

`index`, `teaching`, `faq`, `glossary` prompts and call sites are untouched.

Per-chapter and per-section failures continue to append to `failures` and don't abort the whole import — same policy as today (`add_game.py` only exits nonzero if *all* sections failed).

### `scripts/compiler/add_game.py`

Passes `pdf_bytes` (not just the pdfplumber-extracted text) down into `compile_game`, since the multimodal calls need the raw PDF. Currently only `rulebook_text` is threaded through; `pdf_bytes` needs to be kept alongside it.

### Outline pass prompt (indicative)

```
System: You are a board game rules analyst.
Prompt: Given this rulebook text for "{name}", identify the page ranges that contain
CORE RULES content (turn structure, actions, combat, scoring, edge cases) —
exclude setup/component lists, FAQ, and glossary-style content.
Divide into at most 8 logical chapters. Return strict JSON:
[{"titulo": "...", "paginas": [start, end]}, ...]
If you cannot confidently identify chapter boundaries, return an empty array.
```

Chapter cap: 6-8. If Gemini returns more, merge adjacent chapters down to the cap rather than truncating (avoids silently dropping rules content — truncation would mean the last chapters' page ranges are never compiled at all).

### Secrets / CI

Add `GEMINI_API_KEY` to the `mybgg` repo's GitHub Actions secrets (same key already used by the Cloudflare Worker) and thread it through `.github/workflows/import-game.yml` as an env var into `add_game.py`, alongside the existing `DEEPSEEK_API_KEY` and `GAMECACHE_BGG_TOKEN`.

---

## Error handling

| Failure | Behavior |
|---|---|
| Outline pass returns malformed/empty JSON, or errors | Silent fallback to single-call `rules.md` generation via DeepSeek on full text (today's behavior) |
| One chapter's multimodal call fails | Chapter recorded in `failures`, remaining chapters still compiled, `rules.md` assembled from whichever chapters succeeded |
| `setup.md` multimodal call fails | Recorded in `failures`, same as any other section failure today |
| All sections fail | `add_game.py` exits with error, as today |
| `llm-only` mode (no PDF) | Entirely unaffected — no outline pass, no multimodal calls |

---

## Cost

Previous: ~6 DeepSeek text calls ≈ $0.08/game (per the original Phase 1 design doc).

New: 1 outline pass (cheap, text) + up to 8 multimodal Gemini calls for `rules` chapters + 1 multimodal Gemini call for `setup` (full PDF) + 4 unchanged DeepSeek text calls. Using Gemini 3.1 Flash-Lite pricing (~$0.25/1M input, ~$1.50/1M output), a typical rulebook still lands in the range of a few cents per game. Since imports are manual and infrequent (not a recurring cost), the absolute dollar amount is not a design constraint — fidelity is the goal.

---

## Testing

- Unit tests for `plan_rules_outline`: valid JSON → parsed list; malformed JSON → `None`; empty array → `None`; >8 chapters → merged down to cap.
- Unit tests for `slice_pages`: correct page count/content in output PDF for a given range; multiple ranges.
- Integration-style test (mocked `GeminiProvider`/`DeepSeekProvider`) verifying `compile_game` takes the multimodal chapter path when outline succeeds, and the fallback path when it doesn't.
- No changes needed to existing tests for `index`, `teaching`, `faq`, `glossary` generation.

---

## Out of scope (future work)

- Mechanics/relationship graph (`/mechanics/` nodes, `graph_index.json`, Worker recommendation logic) — separate spec, next in this session.
- Re-importing/backfilling existing wiki entries with the new pipeline.
- Any change to the chat Worker or `deepDiveContext.js` — already functions as intended.

# PDF Acquisition Cascade — Design

**Date:** 2026-06-30
**Scope:** Improve the Knowledge Compiler (Phase 1) to automatically find rulebook PDFs instead of silently falling back to LLM-generated rules.

---

## Context

The Knowledge Compiler (`scripts/compiler/`) imports board games into `mybgg-wiki`. It accepts an optional `pdf_url` to extract authoritative rules text. When no URL is provided, it currently falls back to LLM knowledge — which can be inaccurate, mix up editions, and contains no indication that the rules may be wrong.

This spec replaces the silent LLM fallback with an explicit cascade that tries to find the PDF automatically, and fails clearly if it can't.

---

## Problem

Using LLM knowledge as a rules source produces:
- Hallucinations that look correct (wrong quantities, edge cases, timing)
- Mixed editions (e.g., 1st vs 2nd edition rules blended together)
- Missing errata and post-launch FAQ rulings
- Unverifiable output — `source: ai-generated` in frontmatter is the only signal

This is acceptable for discovery metadata but not for the deep dive rules chat, where a user may act on wrong information during a game.

---

## Solution: PDF Acquisition Cascade

```
pdf_url provided by user?
    ├── Yes → download PDF                          source: pdf-manual
    └── No  → search Tavily: "{name}" rulebook PDF filetype:pdf
                  ├── found valid PDF? → download   source: pdf-web
                  └── No → scrape BGG Files section
                                ├── found PDF? → download  source: pdf-bgg
                                └── No → FAIL (exit 1, clear error message)
```

No LLM fallback. If no PDF is found, the workflow fails explicitly.

---

## Repository Changes

Only `scripts/compiler/` in `mybgg` is modified. The wiki, Worker, and chat are unchanged.

```
scripts/compiler/
├── add_game.py        ← modified: cascade orchestration
├── web_searcher.py    ← NEW
├── bgg_scraper.py     ← NEW
├── pdf_fetcher.py     ← unchanged
├── pdf_parser.py      ← unchanged
├── bgg_fetcher.py     ← unchanged
├── llm_compiler.py    ← unchanged
├── llm_provider.py    ← unchanged
└── wiki_writer.py     ← unchanged
```

---

## Module Specs

### `web_searcher.py`

Searches Tavily for a rulebook PDF URL.

**Interface:**
```python
def search_rulebook_pdf(game_name: str, tavily_api_key: str) -> str | None:
    """Returns a PDF URL or None if not found."""
```

**Implementation:**
- POST to `https://api.tavily.com/search`
- Query: `"{game_name}" rulebook PDF filetype:pdf`
- Headers: `Content-Type: application/json`
- Body: `{"api_key": key, "query": ..., "max_results": 5}`
- Filter results to URLs ending in `.pdf` or containing `/pdf` or `pdf=`
- For each candidate URL: send `HEAD` request, check `Content-Type: application/pdf`
- Return first URL that passes the Content-Type check, or `None`

### `bgg_scraper.py`

Scrapes BGG's Files section to find a rulebook PDF.

**Interface:**
```python
def scrape_bgg_rulebook(bgg_id: int) -> str | None:
    """Returns a PDF URL or None if not found."""
```

**Implementation:**
- GET `https://boardgamegeek.com/boardgame/{bgg_id}/files`
- Parse HTML: find `<a>` tags linking to `.pdf` files
- Filter to links where the filename contains `rule`, `rulebook`, or `regla` (case-insensitive)
- If multiple matches: prefer the one with the highest download count (visible in the page)
- Return the URL of the best match, or `None`
- Use `User-Agent: mybgg-wiki-compiler/1.0` header to identify the bot

### `add_game.py` — Updated Cascade

```python
def acquire_pdf(game_data, pdf_url, tavily_key) -> tuple[bytes, str]:
    """Returns (pdf_bytes, source_label) or raises RuntimeError."""

    if pdf_url:
        return fetch_pdf(pdf_url), "pdf-manual"

    print("No PDF URL provided — searching Tavily...")
    found_url = search_rulebook_pdf(game_data["name"], tavily_key)
    if found_url:
        print(f"Found via web search: {found_url}")
        return fetch_pdf(found_url), "pdf-web"

    print("Not found via web — checking BGG Files...")
    found_url = scrape_bgg_rulebook(game_data["bgg_id"])
    if found_url:
        print(f"Found in BGG Files: {found_url}")
        return fetch_pdf(found_url), "pdf-bgg"

    raise RuntimeError(
        f"Could not find a rulebook PDF for '{game_data['name']}'. "
        "Provide a pdf_url manually to proceed."
    )
```

---

## Secrets

### New secret in `mybgg` GitHub repo

| Secret | Purpose |
|---|---|
| `TAVILY_API_KEY` | Tavily Search API for PDF discovery |

### Existing secrets (unchanged)

| Secret | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | LLM calls for wiki section generation |
| `WIKI_GITHUB_TOKEN` | Push commits to mybgg-wiki |
| `GAMECACHE_BGG_TOKEN` | BGG API metadata fetch |

---

## Frontmatter Changes

The `source` field in `games/{slug}/index.md` frontmatter now has four possible values:

| Value | Meaning |
|---|---|
| `pdf-manual` | User provided the PDF URL directly |
| `pdf-web` | PDF found automatically via Tavily search |
| `pdf-bgg` | PDF found in BGG Files section |
| ~~`ai-generated`~~ | Removed — workflow now fails instead |

The `pdf_url` field is also written to frontmatter for `pdf-web` and `pdf-bgg` sources, so the source can be inspected and the PDF re-downloaded if needed.

---

## Error Handling

| Failure | Behavior |
|---|---|
| Tavily API key missing | Skip Tavily step, log warning, continue to BGG scrape |
| Tavily returns no PDF candidates | Log, continue to BGG scrape |
| HEAD request returns non-PDF Content-Type | Skip that URL, try next candidate |
| BGG scrape returns no PDF | Log, raise RuntimeError |
| Downloaded PDF is 0 bytes or corrupt | `pdf_parser.py` raises, caught in `add_game.py`, logged as failure |
| Workflow fails | Exit code 1, GitHub Actions marks run as failed |

---

## Out of Scope

- Validating PDF content matches the correct game (e.g., via LLM spot-check)
- Caching found PDF URLs to avoid re-searching on re-runs
- Supporting non-PDF formats (e.g., HTML rules pages)
- Automatic retry on BGG scrape rate limits

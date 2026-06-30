# Design: Remove PDF Acquisition Cascade

**Date:** 2026-06-30
**Status:** Approved

## Problem

The current `acquire_pdf` cascade in `add_game.py` tries three sources in order:

1. Manual `--pdf_url`
2. Tavily web search
3. BGG Files scraper

Steps 2 and 3 are edition-blind — they retrieve whatever PDF they find first, which may correspond to a different edition than the physical copy being catalogued. This undermines the edition-tracking goal introduced in the edition support feature.

## Decision

Remove both automatic fallbacks (Tavily and BGG Files scraper). Replace the cascade with two explicit, user-controlled paths:

- **PDF path**: user provides `--pdf_url` pointing to the exact rulebook for their physical edition
- **LLM-only path**: no PDF; LLM generates content from general knowledge, explicitly scoped to the declared edition

## Architecture

### Files deleted

- `scripts/compiler/web_searcher.py`
- `scripts/compiler/bgg_scraper.py`
- `tests/compiler/test_web_searcher.py` (if it exists)
- `tests/compiler/test_bgg_scraper.py` (if it exists)

### `scripts/compiler/add_game.py`

Remove `acquire_pdf` function and all imports of `web_searcher`, `bgg_scraper`.

`main()` branches explicitly:

```python
if pdf_url:
    pdf_bytes = fetch_pdf(pdf_url)
    rulebook_text = extract_text(pdf_bytes)
    source = "pdf-manual"
    resolved_url = pdf_url
else:
    if not edition:
        print("Error: --edition is required when --pdf_url is not provided.")
        sys.exit(1)
    rulebook_text = None
    source = "llm-only"
    resolved_url = None
```

`TAVILY_API_KEY` lookup removed from `main()`.

### `scripts/compiler/llm_compiler.py`

`_rulebook_block()` receives `game_data` in addition to `rulebook_text` so it can include the edition when falling back to LLM knowledge:

```python
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
```

### `scripts/compiler/wiki_writer.py`

When `source == "llm-only"`, prepend a warning callout to the content of each generated page:

```markdown
> [!WARNING]
> Contenido generado desde conocimiento general del LLM sin rulebook verificado.
> Edición de referencia: **{edition}**. Puede diferir de otras ediciones.
```

This callout is not added for `pdf-manual` or any other source.

### `.github/workflows/import-game.yml`

- Remove `TAVILY_API_KEY` from the `Import game` step env block
- Update `pdf_url` input description:

```yaml
pdf_url:
  description: 'Direct URL to the rulebook PDF for your physical edition (if omitted, --edition is required and content is generated from LLM knowledge)'
  required: false
```

No other workflow changes needed — `edition` already exists as an optional input; validation happens in Python.

## Validation rules

| Condition | Result |
|---|---|
| `--pdf_url` provided | Download PDF, extract text, compile. `--edition` optional (defaults to BGG year). |
| No `--pdf_url`, `--edition` provided | LLM-only compile with edition context + wiki warning. |
| No `--pdf_url`, no `--edition` | Error and `sys.exit(1)`. |

## Source labels

| Source | Meaning |
|---|---|
| `pdf-manual` | PDF downloaded from user-provided URL |
| `llm-only` | No PDF; generated from LLM general knowledge |

`pdf-web` and `pdf-bgg` labels are no longer used and can be removed from any display logic in `wiki_writer.py`.

## Tests

- Delete tests for `web_searcher` and `bgg_scraper`
- Update `add_game` tests: remove cascade tests, add test for validation error when no `--pdf_url` and no `--edition`
- Add test that LLM-only path passes `rulebook_text=None` to `compile_game`
- Add test that `wiki_writer` prepends the warning callout when `source == "llm-only"`

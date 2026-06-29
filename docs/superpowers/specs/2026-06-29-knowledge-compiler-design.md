# Knowledge Compiler — Phase 1 Design

**Date:** 2026-06-29
**Scope:** Phase 1 of the Board Game Knowledge Platform. Builds the compiler pipeline only. Website UI and AI Chat are future phases.

---

## Vision

Transform mybgg from a collection browser into a **Board Game Knowledge Platform**.

The wiki is the product. Everything else — AI chat, website, search — is an interface to the compiled knowledge.

This document covers **Phase 1**: the knowledge compiler that imports a game into the wiki.

---

## Repository Structure

Two repos with separate concerns:

```
mybgg (public, existing)           mybgg-wiki (private, new)
├── scripts/
│   ├── gamecache/     [unchanged]
│   └── compiler/      [new]       games/
│       ├── add_game.py             └── root/
│       ├── bgg_fetcher.py              ├── index.md
│       ├── pdf_fetcher.py              ├── setup.md
│       ├── llm_compiler.py             ├── rules.md
│       └── wiki_writer.py              ├── teaching.md
├── .github/workflows/                  ├── faq.md
│   └── import-game.yml [new]           └── glossary.md
└── [existing code unchanged]       mechanics/
                                    glossary/
                                    .obsidian/
```

`mybgg-wiki` is a private GitHub repo, directly usable as an Obsidian vault.

---

## Import Flow

Triggered manually from the GitHub Actions UI (`workflow_dispatch`). No custom web interface in this phase.

```
GitHub Actions UI
(inputs: game_name, pdf_url?, status)
        ↓
import-game.yml runs in the cloud
        ↓
1. Fetch BGG metadata
2. Acquire PDF (URL → BGG files → LLM fallback)
3. DeepSeek generates each wiki section independently
4. Write Markdown files to mybgg-wiki
5. Commit + push
```

### Workflow Inputs

| Input | Required | Description |
|---|---|---|
| `bgg_id` | Yes | BGG game ID — the number in the BGG URL (e.g. `237182` for Root) |
| `pdf_url` | No | Direct URL to the rulebook PDF |
| `status` | Yes | `owned`, `wishlist`, `borrowed`, `friend`, `played`, `archived` |

The BGG ID is unambiguous and requires no name resolution. Find it in any BGG game page URL: `boardgamegeek.com/boardgame/237182/root`.

### PDF Acquisition Cascade

The BGG XML API does not expose the user-uploaded files section, so searching BGG for PDFs is not feasible via the API. The cascade is:

```
pdf_url provided?
    ├── Yes → download PDF from URL → extract text with pdfplumber
    └── No  → compile from LLM knowledge
              (source: ai-generated in frontmatter)
```

### Required Secrets in mybgg

| Secret | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek LLM calls |
| `WIKI_GITHUB_TOKEN` | Push commits to mybgg-wiki (PAT with repo scope) |
| `GAMECACHE_BGG_TOKEN` | BGG API — already exists, reused |

---

## Wiki Structure

### Per-Game Pages

Each game gets a folder under `games/{slug}/` with six Markdown files:

| File | Content |
|---|---|
| `index.md` | Overview, BGG metadata, ownership status |
| `setup.md` | Components, preparation, initial configuration |
| `rules.md` | Complete rules reference |
| `teaching.md` | 5-minute explanation, teaching order, common mistakes |
| `faq.md` | Frequently asked questions, forgotten rules |
| `glossary.md` | Game-specific terms with EN/ES translations |

### Frontmatter Schema (`index.md`)

```yaml
---
bgg_id: 237182
name: Root
slug: root
status: owned
source: pdf            # pdf | bgg-files | ai-generated
pdf_url: https://...   # URL of processed PDF (if applicable)
bgg_rank: 21
players: "2-4"
weight: 3.72
mechanics:
  - Area Control
  - Hand Management
imported: 2026-06-29
---
```

`source` tracks knowledge provenance so human-curated content can be distinguished from AI-generated content.

### Wiki Links

Pages use Obsidian-style wiki links to connect related knowledge:

```markdown
Root uses [[Area Control]] and [[Hand Management]].
The [[Vagabond]] follows unique movement rules.
```

---

## Compiler Module

### File Structure

```
scripts/compiler/
├── add_game.py        ← orchestrator: coordinates all steps
├── bgg_fetcher.py     ← fetches BGG metadata (reuses bgg_client.py)
├── pdf_fetcher.py     ← downloads PDF from URL
├── pdf_parser.py      ← extracts plain text from PDF using pdfplumber
├── llm_compiler.py    ← generates wiki sections via DeepSeek
└── wiki_writer.py     ← writes .md files and commits to wiki repo
```

**PDF processing note:** DeepSeek's API accepts text, not binary files. The pipeline is: download PDF → `pdfplumber` extracts plain text → full text is included in each LLM section prompt. For a typical rulebook (~50 pages → ~40k tokens of text), six section calls at DeepSeek V3 prices cost roughly $0.08 total.

### LLM Abstraction

The LLM provider is swappable without changing compiler logic:

```python
class LLMProvider:
    def generate(self, system: str, prompt: str) -> str: ...

class DeepSeekProvider(LLMProvider):
    # openai SDK pointing to api.deepseek.com

class AnthropicProvider(LLMProvider):
    # optional fallback for critical sections
```

Default provider: **DeepSeek V3** via OpenAI-compatible API.

### Section Generation Order

One LLM call per section. Order matters — `index.md` is generated first because later sections reference it:

```
1. index.md    ← BGG metadata + game summary
2. setup.md    ← setup and components
3. rules.md    ← complete rules
4. teaching.md ← teaching guide (references rules.md)
5. faq.md      ← FAQs and forgotten rules (references rules.md)
6. glossary.md ← game terms with EN/ES translations
```

If a section call fails, the process continues with remaining sections and logs which ones failed. Successfully generated sections are not lost. Failed sections can be regenerated individually by re-running the workflow.

---

## Multilingual Strategy

The wiki is written in English (the language of most authoritative sources).

The `glossary.md` per game captures key terms with Spanish translations:

```yaml
- term: Worker Placement
  es: Colocación de Trabajadores

- term: Victory Points
  es: Puntos de Victoria
```

Spanish responses from the AI chat layer (Phase 2) are handled at query time, not at compile time. The wiki itself does not have duplicate Spanish pages.

---

## Out of Scope (Future Phases)

- **Phase 2 — AI Chat**: query interface that reads the wiki and answers questions in EN/ES
- **Phase 3 — Website**: bgg.cardila.com displays wiki content alongside the existing collection browser
- **MCP integration**: optional, after Phase 2
- **Game Night Mode**: UI feature, Phase 3
- **Import UI in the website**: form on bgg.cardila.com that triggers the workflow

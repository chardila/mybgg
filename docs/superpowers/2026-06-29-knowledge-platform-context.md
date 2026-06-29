# Board Game Knowledge Platform — Contexto y PRD

**Fecha:** 2026-06-29
**Propósito:** Preservar la visión completa del producto y las decisiones de diseño tomadas en la sesión de brainstorming.

---

## Decisiones de Arquitectura

| Decisión | Opción elegida | Razón |
|---|---|---|
| ¿Extender mybgg? | Sí, Opción A | El BGG client existente justifica reutilizar el repo |
| Relación con upstream gamecache | Independiente | mybgg ya es un proyecto propio |
| ¿Dónde vive el wiki? | Repo separado (`mybgg-wiki`) | Separar contenido de código; Obsidian vault limpio |
| ¿Wiki público o privado? | Privado | Libertad para experimentar; se puede publicar después |
| ¿Cómo se dispara el import? | GitHub Actions `workflow_dispatch` | Sin interfaz custom por ahora; mismo patrón que mybgg |
| LLM proveedor | DeepSeek V3 (vía API OpenAI-compatible) | Barato, suficientemente bueno para document→Markdown |
| Fuente de reglas | PDF manual → LLM fallback | BGG API no expone archivos; usuario provee el PDF |
| Enfoque del compilador | Sección por sección (Opción 2) | Mejor calidad, iterable por sección |
| Stack | Python (existente) para compilador | Fase 2 (AI Chat) revaluará el stack web |

---

## PRD Original — Visión Completa

*El siguiente PRD fue propuesto por el usuario como actualización a un documento anterior. Representa la visión a largo plazo del producto.*

---

### Vision

Build a **living, multilingual knowledge platform** for board games, inspired by Andrej Karpathy's **LLM Wiki / Engram** concept.

The platform continuously collects information from authoritative sources, compiles it into a structured Markdown wiki, and exposes that knowledge through multiple interfaces.

The wiki is the product.

Everything else—including AI chat, website search, recommendations, and future integrations—is simply another way of exploring the compiled knowledge.

---

### Product Philosophy

The system should behave like a **knowledge compiler**, not a traditional RAG application.

```
Authoritative Sources
        │
        ▼
Knowledge Compiler
        │
        ▼
Markdown Wiki (Single Source of Truth)
        │
        ├── Static Website
        ├── AI Chat
        ├── Search
        ├── Obsidian Vault
        ├── Recommendation Engine
        └── Optional MCP Server
```

Business logic exists only inside the compiler.

Every other component consumes the compiled knowledge.

---

### Canonical Knowledge

The Markdown wiki is the only canonical representation of knowledge.

Everything else is generated from it.

Examples of generated artifacts:

* Static website
* Search indexes
* Embeddings
* AI prompts
* Recommendation indexes
* MCP resources

Artifacts are disposable.

The wiki is permanent.

---

### Knowledge Repository

The repository should be fully version controlled.

Goals:

* Git as the database
* Markdown as the storage format
* Human-readable
* AI-friendly
* Portable
* Reproducible

The repository should be directly usable as an Obsidian Vault.

---

### Game Lifecycle

Every game follows the same lifecycle.

```
Discover Game → Add to Library → Collect Knowledge → Compile Knowledge
→ Update Wiki → Review Changes → Commit → Push → Publish
```

Knowledge compilation should be repeatable whenever new information becomes available.

---

### Library Management

Games can exist independently of ownership.

Possible ownership states:

* Owned
* Wishlist
* Borrowed
* Friend's Copy
* Previously Played
* Archived

Example: A friend brings a game to game night. The user adds it to the library. The compiler downloads all available information, builds the wiki, and makes it immediately searchable—even if the game is not owned.

Ownership affects organization, never knowledge generation.

---

### Knowledge Collection

Collectors are modular. Each collector specializes in one source.

Examples:

* BoardGameGeek
* Official Rulebooks
* Publisher Websites
* FAQs
* Rules Forums
* Designer Clarifications
* Official Errata

Future collectors should be easy to add without modifying the rest of the system.

---

### Knowledge Compilation

The compiler transforms documents into knowledge.

Responsibilities include:

* document parsing
* deduplication
* conflict detection
* section generation
* summarization
* wiki link generation
* concept extraction
* glossary generation
* relationship discovery

The objective is not document storage. The objective is knowledge synthesis.

---

### Wiki Structure

The wiki should naturally evolve into an interconnected knowledge graph.

```
games/
    root/
        overview.md
        setup.md
        combat.md
        factions.md
        faq.md
        teaching.md
        strategy.md

mechanics/
concepts/
recommendations/
glossary/
sessions/
```

Relationships should be expressed using wiki links:

```markdown
Root uses [[Area Control]] mechanics.
See also [[Card Crafting]].
The [[Vagabond]] follows unique movement rules.
```

---

### Multilingual Knowledge

Most authoritative sources will be collected in their original language (primarily English).

The wiki itself remains language-neutral.

The AI layer is responsible for presenting knowledge in the user's preferred language.

Goals:

* Answer questions in English or Spanish.
* Preserve official terminology whenever possible.
* Translate explanations rather than raw documents.
* Adapt language for different audiences.

The system should support multilingual conversations without requiring duplicate copies of the wiki.

---

### Terminology Glossary

The compiler should maintain a canonical glossary of board game terminology.

```yaml
canonical_term: Worker Placement
translations:
  en: Worker Placement
  es: Colocación de Trabajadores
aliases:
  - WP

canonical_term: Victory Points
translations:
  en: Victory Points
  es: Puntos de Victoria
```

The glossary ensures consistent terminology across languages. Whenever official localized terminology exists, it should be preferred.

---

### Teaching Support

Teaching a game is a first-class feature.

For each game, the compiler should generate teaching-oriented knowledge such as:

* Five-minute explanation
* Suggested teaching order
* First-round walkthrough
* Common mistakes
* Rules that can be postponed
* Frequently forgotten details

These pages may eventually be manually curated because they are expected to be frequently used during game nights.

---

### AI Chat

The chat interface is only one way of consuming the knowledge.

```
User Question → Search Wiki → Load Relevant Pages → Build Prompt → LLM → Answer
```

The AI never answers directly from PDFs. It answers from curated knowledge.

---

### Search Strategy

The MVP intentionally avoids databases and vector search.

```
Markdown Wiki → Generate Static Search Index → Search Relevant Pages → Load Markdown → LLM
```

This architecture keeps the system simple while supporting a personal-scale knowledge base.

Embeddings may be introduced later only if keyword search proves insufficient.

---

### Website

The existing website (bgg.cardila.com) becomes one interface to the knowledge platform.

Current features:

* Browse collection
* Search owned games

Future features:

* Knowledge Wiki
* Rules Explorer
* AI Chat
* Teaching Guides
* FAQ
* Related Games
* Mechanics Browser
* Recommendation Assistant
* Game Night Mode

The website should feel like navigating a board game encyclopedia rather than interacting with a chatbot.

---

### Game Night Mode

Game Night Mode is a primary user experience. The objective is minimizing interruptions while playing.

```
Select Game → Game Night Dashboard → Quick Actions:
• Explain the game     • Setup guide
• Search rules         • Ask a question
• Common mistakes      • Rule references
• FAQ                  • End-of-round reminders
```

The interface should optimize for fast answers during live gameplay.

---

### MCP Integration

An MCP server is **not** part of the core architecture. It is an optional integration layer.

Potential consumers: Claude Code, ChatGPT, Cursor, future AI agents.

The MCP should expose the compiled knowledge without implementing business logic. If removed entirely, the platform should continue functioning exactly the same.

---

### Long-Term Vision

Create a **Board Game Brain**.

A continuously evolving, multilingual knowledge system that understands board games better over time.

Rather than asking an LLM to memorize board game rules, the platform continuously compiles authoritative information into a curated, interconnected Markdown wiki.

The knowledge becomes durable. Interfaces come and go. The wiki remains.

---

## Fases de Implementación

### Phase 1 — Knowledge Compiler (spec completo en `2026-06-29-knowledge-compiler-design.md`)
Compilador CLI disparado via GitHub Actions. Importa un juego a la vez con PDF + BGG metadata → genera wiki Markdown en `mybgg-wiki`.

### Phase 2 — AI Chat
Interface de chat que lee el wiki y responde preguntas en EN/ES. Stack por definir (probablemente serverless). El wiki debe tener contenido real antes de empezar esta fase.

### Phase 3 — Website Enhancement
bgg.cardila.com muestra el wiki. Game Night Mode. Rules Explorer. Teaching Guides. Import UI en el sitio.

### Futuro
Mechanics browser, recommendation engine, MCP opcional, sesiones de juego.

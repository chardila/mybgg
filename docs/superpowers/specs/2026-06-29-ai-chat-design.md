# AI Chat — Phase 2 Design

**Date:** 2026-06-29
**Scope:** Phase 2 of the Board Game Knowledge Platform. Adds an AI chat interface backed by the wiki compiled in Phase 1.

---

## Context

This document is self-contained. A new session implementing this spec does not need prior conversation context.

**Phase 1 (complete):** A GitHub Actions `workflow_dispatch` workflow in `mybgg` imports a board game from BGG + optional PDF rulebook into a private GitHub repo called `mybgg-wiki`. Each game gets a folder `games/{slug}/` with six Markdown files: `index.md`, `setup.md`, `rules.md`, `teaching.md`, `faq.md`, `glossary.md`. Phase 1 code lives in `scripts/compiler/` of the `mybgg` repo.

**Phase 2 (this spec):** Add an AI chat interface so the user can ask questions about their game collection — first to find a game for game night (discovery mode), then to get detailed rules help for the chosen game (deep dive mode).

---

## Repositories Involved

| Repo | Visibility | Role |
|---|---|---|
| `chardila/mybgg` | Public | Static site on GitHub Pages at `bgg.cardila.com`. Phase 2 adds `chat.html` here. |
| `chardila/mybgg-wiki` | Private | Wiki content. Phase 2 adds a GitHub Actions sync workflow here. |

---

## Architecture

Three systems, two repos:

```
mybgg-wiki (private)
    │  push to main → GitHub Action (sync-to-kv.yml)
    │                 └── sync all .md files → Cloudflare KV namespace "WIKI"
    │
mybgg (public, GitHub Pages at bgg.cardila.com)
    ├── index.html      [UNCHANGED — do not touch]
    └── chat.html       [NEW — static page, no framework]
              │
              │  POST /api/chat (SSE)
              ▼
        Cloudflare Worker  (route: bgg.cardila.com/api/*)
              ├── reads KV: catalog or game sections
              └── calls DeepSeek → streams tokens → SSE → browser
```

**Key constraints:**
- `index.html` must not be modified. The existing site is embedded in `blog.cardila.com` and must continue working unchanged.
- The chat is a fully separate page (`chat.html`), no shared state with `index.html`.
- The Worker is deployed to Cloudflare, routed under `bgg.cardila.com/api/` via a Cloudflare route rule.

---

## Cloudflare KV Structure

**Namespace name:** `WIKI`

| Key | Value | Written by |
|---|---|---|
| `catalog` | JSON array of all games (see schema below) | sync-to-kv.yml on every push |
| `games/{slug}/index` | content of `games/{slug}/index.md` | sync-to-kv.yml on every push |
| `games/{slug}/setup` | content of `games/{slug}/setup.md` | sync-to-kv.yml on every push |
| `games/{slug}/rules` | content of `games/{slug}/rules.md` | sync-to-kv.yml on every push |
| `games/{slug}/teaching` | content of `games/{slug}/teaching.md` | sync-to-kv.yml on every push |
| `games/{slug}/faq` | content of `games/{slug}/faq.md` | sync-to-kv.yml on every push |
| `games/{slug}/glossary` | content of `games/{slug}/glossary.md` | sync-to-kv.yml on every push |

**`catalog` JSON schema:**
```json
[
  {
    "slug": "pandemic",
    "name": "Pandemic",
    "players": "2-4",
    "weight": "2.41",
    "playing_time": "45",
    "mechanics": ["Cooperative", "Hand Management"],
    "categories": ["Medical"],
    "status": "owned",
    "rank": "70"
  }
]
```

Built by the sync script reading YAML frontmatter from each `games/*/index.md`. Fields come from what Phase 1 writes into frontmatter (bgg_id, name, slug, status, players, weight, rank, mechanics, playing_time).

---

## Sync Workflow (in `mybgg-wiki`)

**File:** `.github/workflows/sync-to-kv.yml`
**Trigger:** `push` to `main`
**Runner:** `ubuntu-latest`

**Steps:**
1. Checkout `mybgg-wiki`
2. Setup Python 3.12
3. Install `pyyaml` (for frontmatter parsing)
4. Run `scripts/build_catalog.py` → writes `catalog.json`
5. Install Wrangler CLI (`npm install -g wrangler`)
6. Upload `catalog.json`: `wrangler kv key put "catalog" --path catalog.json`
7. For each game in `games/*/`, upload each section that exists:
   ```bash
   for slug in games/*/; do
     slug=$(basename $slug)
     for section in index setup rules teaching faq glossary; do
       if [ -f "games/$slug/$section.md" ]; then
         wrangler kv key put "games/$slug/$section" --path "games/$slug/$section.md"
       fi
     done
   done
   ```

**Secrets required in `mybgg-wiki` GitHub repo:**
| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers KV Storage:Edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

**Variable (not secret) in `mybgg-wiki` GitHub repo:**
| Variable | Value |
|---|---|
| `KV_NAMESPACE_ID` | The ID of the WIKI KV namespace (from Cloudflare dashboard) |

**`scripts/build_catalog.py`** (in `mybgg-wiki`):
- Reads every `games/*/index.md`
- Parses YAML frontmatter (between `---` delimiters)
- Extracts: slug, name, players, weight, playing_time, mechanics, categories, status, rank
- Writes `catalog.json`

---

## Cloudflare Worker

**Location:** New Cloudflare Worker project, separate from existing Workers used for blog comments and the poll system.

**Route:** `bgg.cardila.com/api/*` (configured in Cloudflare dashboard as a Worker route)

**File structure:**
```
worker/
├── src/
│   └── index.js        ← main Worker (single file)
├── wrangler.toml       ← Cloudflare config
└── package.json
```

Worker lives in the `mybgg` repo under `worker/`.

### Endpoints

**`POST /api/chat`** — Main chat endpoint, streams SSE

Request body (JSON):
```json
{
  "message": "string",
  "history": [
    {"role": "user", "content": "string"},
    {"role": "assistant", "content": "string"}
  ],
  "mode": "discovery | deep_dive",
  "game": "slug-string | null",
  "language": "en | es"
}
```

Response: `text/event-stream` (SSE)
```
data: {"token": "some"}
data: {"token": " text"}
data: [DONE]
```
On error:
```
data: {"error": "message"}
```

**`GET /api/games`** — Returns catalog for the game selector

Response: JSON array from `KV.get("catalog")`

### Worker Logic

```
POST /api/chat
    ├── mode = "discovery"
    │       └── context = await KV.get("catalog")          [1 read]
    │           system = discovery_system_prompt(language)
    │           + catalog as context
    │
    └── mode = "deep_dive"
            └── load in parallel:
                  KV.get("games/{game}/index")
                  KV.get("games/{game}/rules")
                  KV.get("games/{game}/teaching")
                  KV.get("games/{game}/faq")
                  KV.get("games/{game}/glossary")          [5 reads]
                system = deep_dive_system_prompt(game_name, language)
                + all sections as context

    └── call DeepSeek API (stream: true)
        model: deepseek-chat
        base_url: https://api.deepseek.com
        messages: [system, ...history, {role: "user", content: message}]

    └── pipe DeepSeek SSE → response SSE
```

### System Prompts

**Discovery mode (es):**
```
Eres un asistente experto en juegos de mesa. Ayudas al usuario a elegir un juego para su noche de juegos.
Tienes acceso al catálogo de juegos del usuario. Responde en español.
Preserva la terminología oficial en inglés cuando no hay traducción establecida (ej: "Worker Placement", "Area Control").
Sé conciso y práctico. Cuando el usuario haya elegido un juego, sugiere que lo seleccione para obtener ayuda detallada.
```

**Discovery mode (en):**
```
You are a board game expert assistant. You help the user choose a game for their game night.
You have access to the user's game catalog. Respond in English.
Be concise and practical. When the user has chosen a game, suggest they select it for detailed help.
```

**Deep dive mode (es):**
```
Eres un experto en {game_name}. Tienes acceso al wiki completo del juego incluyendo reglas, setup, guía de enseñanza, FAQ y glosario.
Responde en español. Preserva los nombres oficiales de componentes y mecánicas en inglés cuando no hay traducción establecida.
Sé preciso con las reglas. Si algo no está en el wiki, dilo claramente.
```

**Deep dive mode (en):**
```
You are an expert on {game_name}. You have access to the complete game wiki including rules, setup, teaching guide, FAQ, and glossary.
Respond in English. Be precise about rules. If something is not in the wiki, say so clearly.
```

### Worker Secrets (Cloudflare dashboard)

| Secret/Binding | Value |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `WIKI` | KV namespace binding (the WIKI namespace) |

### CORS

The Worker must include CORS headers to allow requests from `bgg.cardila.com`:
```
Access-Control-Allow-Origin: https://bgg.cardila.com
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

Handle `OPTIONS` preflight requests.

---

## Frontend (`chat.html`)

**Location:** `chat.html` in the root of `mybgg` repo (same level as `index.html`), served from `bgg.cardila.com/chat.html`.

**Technology:** Plain HTML + CSS + vanilla JS. No frameworks. No build step. No npm.

### Layout

```
┌─────────────────────────────────────────┐
│  My Board Games — Chat    [EN] [ES]     │
├─────────────────────────────────────────┤
│                                         │
│  [Modo: Descubrimiento de juego]        │  ← mode indicator
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ [assistant] Hola! Tengo 12 juegos │  │
│  │ en tu colección. ¿Qué tipo de    │  │
│  │ noche de juegos tienes en mente? │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │ [user] Somos 5 personas           │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │ [assistant] Te recomiendo...▋     │  │  ← streaming cursor
│  └───────────────────────────────────┘  │
│                                         │
│  Juego de la noche: [Seleccionar ▼]    │  ← game selector
├─────────────────────────────────────────┤
│  [Escribe una pregunta...   ] [Enviar]  │
└─────────────────────────────────────────┘
```

### Behavior

**On page load:**
1. Fetch `GET /api/games` to populate the game selector dropdown
2. Send an automatic opening message in discovery mode: "Hola! Tengo {N} juegos en tu colección. ¿Qué tipo de noche de juegos tienes en mente?" (or English equivalent)

**Language toggle:**
- Two buttons: `EN` / `ES`, active state highlighted
- Default: `es`
- Changing language updates the `language` field sent on future messages
- Does NOT clear conversation history — the assistant will switch language naturally

**Game selector:**
- Dropdown populated from `/api/games` catalog
- Default: empty ("Seleccionar juego")
- When user selects a game:
  - Switch mode to `deep_dive`, set `game` to the slug
  - Clear conversation history
  - Show mode indicator: "Modo: [Game Name]"
  - Send automatic opening message: "Listo para responder preguntas sobre {Game Name}. Tengo acceso a las reglas, setup y guía de enseñanza. ¿Qué necesitas saber?"
- A "Volver a descubrimiento" link/button below the selector resets to discovery mode and clears history

**Message sending:**
- Enter key or Enviar button submits
- Input disabled while streaming
- Fetch `POST /api/chat` with `mode`, `game`, `language`, `message`, `history`
- Render SSE tokens into the current assistant message bubble as they arrive
- Show blinking cursor `▋` while streaming
- On `[DONE]`, add the complete message to history

**Markdown rendering:**
- Render basic markdown in assistant messages: `**bold**`, `*italic*`, `- lists`, `# headings`, `` `code` ``
- Use a minimal inline renderer (~50 lines of JS), no external library

**Error handling:**
- If `/api/games` fails: show "No se pudo cargar la lista de juegos" and disable the selector
- If `/api/chat` fails or returns error event: show "Error al conectar con el asistente. Intenta de nuevo." inline in the chat
- Network errors: same inline error message

**No persistence:** Conversation history lives in a JS array in memory. Refreshing the page starts fresh.

**Link back to main site:**
- Header includes a link: `← Mi colección` pointing to `bgg.cardila.com`

---

## Deployment

### One-time setup (manual steps before first deploy)

1. **Create KV namespace** in Cloudflare dashboard: name it `WIKI`. Note the namespace ID.
2. **Create Worker** via `wrangler deploy` from `worker/` directory in `mybgg` repo.
3. **Add Worker route** in Cloudflare dashboard: `bgg.cardila.com/api/*` → the Worker.
4. **Add secrets to Worker** via Cloudflare dashboard or `wrangler secret put`:
   - `DEEPSEEK_API_KEY`
5. **Add KV binding** to Worker in `wrangler.toml`:
   ```toml
   [[kv_namespaces]]
   binding = "WIKI"
   id = "<KV_NAMESPACE_ID>"
   ```
6. **Add secrets to `mybgg-wiki` GitHub repo:**
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
7. **Add variable to `mybgg-wiki` GitHub repo:**
   - `KV_NAMESPACE_ID`
8. **Run sync once manually** to populate KV with existing wiki content.

### Ongoing deployment

| What changed | Deploy action |
|---|---|
| Wiki content (push to `mybgg-wiki/main`) | Automatic: `sync-to-kv.yml` runs, KV updated |
| Worker code (`worker/src/index.js`) | `wrangler deploy` from `worker/` (can be added to a `mybgg` workflow later) |
| `chat.html` | Automatic: GitHub Pages deploy on push to `mybgg/master` |

---

## Out of Scope (Future Phases)

- Conversation history persistence (localStorage or server-side)
- Authentication — the chat is public (same as the rest of the site)
- Embeddings or vector search — keyword/catalog search is sufficient for personal-scale
- Game Night Mode dashboard (Phase 3)
- Import UI on the website (Phase 3)
- MCP server integration (future)
- Wrangler-based CI/CD for the Worker (can be added later)

---

## Success Criteria

- [ ] User can open `bgg.cardila.com/chat.html` and ask questions about their collection
- [ ] User can select a game and switch to deep dive mode for rules questions
- [ ] Responses stream token by token (no waiting for full response)
- [ ] Language toggle switches between EN and ES
- [ ] Pushing new game to mybgg-wiki automatically makes it available in the chat within minutes
- [ ] `index.html` and the existing site continue working unchanged

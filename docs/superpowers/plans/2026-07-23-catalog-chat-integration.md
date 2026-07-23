# Catálogo ↔ Chat Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two navigation entry points from the static catalog (`index.html`) into the chat assistant (`chat.html`): a per-game "Chat about this game" link that starts a deep-dive session for that exact game, and a header-level "Ask the assistant" button that jumps to discovery mode, carrying over any text already typed in the catalog's search box.

**Architecture:** Pure frontend, three independent static files touched (`index.html`/`app-sqlite.js`/`style.css` for the two new UI triggers; `chat.html` for reading the URL parameters they produce). No changes to `worker/` or `scripts/compiler/`. Navigation is a plain page load (`<a href>` / `window.location.href`) — `chat.html` and `index.html` remain two independent static pages, matching the site's existing GitHub Pages deployment model.

**Tech Stack:** Vanilla JS, no build step, no test framework for these files (matches existing project pattern — verification is manual in-browser).

## Global Constraints

- No changes to `worker/src/index.js` or any file under `scripts/compiler/` — this feature is 100% static frontend.
- `chat.html`'s `WORKER_URL` stays `''` (same-origin) — do not hardcode a Worker URL into committed code, even temporarily for testing (see Task 3 notes).
- Reuse existing CSS classes (`.stat-item`, `.icon-themed`, global `a { color: #b71c1c; }`) instead of inventing new ones, except where a genuinely new UI element (`.chat-cta`) requires its own rule.
- Text passed into `chat.html` via URL (`name`, `q`) must go through the existing `sendMessage()` escaping path — never `innerHTML` it directly.
- No `target="_blank"` on the new game-card chat link or the header button — both are same-site navigation, same tab.

---

### Task 1: Per-game "Chat about this game" link

**Files:**
- Modify: `index.html:129-132` (inside `#game-card-template`, `.bottom-info`)
- Modify: `app-sqlite.js:1570-1574` (inside `renderGameCard(game)`)

**Interfaces:**
- Consumes: `game.id` (BGG numeric id) and `game.name`, both already populated on every game object passed into `renderGameCard(game)` — confirmed in use at `app-sqlite.js:1572-1573` (BGG link) and `app-sqlite.js:1485` (`game.name`).
- Produces: a `.chat-link` anchor per rendered card, `href` set to `chat.html?bgg_id=<id>&name=<urlencoded name>`. Task 3 consumes this URL shape (`bgg_id`, `name` params) on the `chat.html` side.

- [ ] **Step 1: Add the new template markup to `index.html`**

Current `index.html:129-132`:

```html
          <div class="stat-item bgg-link-section">
            <span class="material-symbols-rounded icon-themed">outbound</span>
            <a href="" target="_blank" class="bgg-link">View on BGG</a>
          </div>
```

Replace with:

```html
          <div class="stat-item bgg-link-section">
            <span class="material-symbols-rounded icon-themed">outbound</span>
            <a href="" target="_blank" class="bgg-link">View on BGG</a>
          </div>
          <div class="stat-item chat-link-section">
            <span class="material-symbols-rounded icon-themed">forum</span>
            <a href="" class="chat-link">Chat about this game</a>
          </div>
```

- [ ] **Step 2: Manually verify the template renders without errors**

Run: `python3 -m http.server 8000` from the repo root, then open `http://localhost:8000/index.html` in a browser.

Expected: page loads with no new console errors, click any game card to expand it, and confirm a new "Chat about this game" row appears in the bottom info bar next to "View on BGG" (it won't be clickable to anywhere useful yet — that's step 4).

- [ ] **Step 3: Wire the href in `renderGameCard`**

Current `app-sqlite.js:1570-1574`:

```js
  // Set BGG link
  const bggLink = clone.querySelector('.bgg-link');
  if (bggLink && game.id) {
    bggLink.href = `https://boardgamegeek.com/boardgame/${game.id}`;
  }
```

Replace with:

```js
  // Set BGG link
  const bggLink = clone.querySelector('.bgg-link');
  if (bggLink && game.id) {
    bggLink.href = `https://boardgamegeek.com/boardgame/${game.id}`;
  }

  // Set chat link
  const chatLink = clone.querySelector('.chat-link');
  if (chatLink && game.id) {
    const params = new URLSearchParams({ bgg_id: game.id, name: game.name });
    chatLink.href = `chat.html?${params.toString()}`;
  }
```

- [ ] **Step 4: Manually verify the href is built correctly**

With the local server from Step 2 still running (reload the page to pick up the JS change), expand any game card, right-click the "Chat about this game" link and inspect it (or hover and read the status bar / use DevTools Elements panel).

Expected: `href="chat.html?bgg_id=<numeric id>&name=<that game's name, URL-encoded>"` — e.g. for a game named "Res Arcana" with BGG id `260428`, `chat.html?bgg_id=260428&name=Res+Arcana`.

- [ ] **Step 5: Commit**

```bash
git add index.html app-sqlite.js
git commit -m "feat: add per-game chat link to game card"
```

---

### Task 2: General "Ask the assistant" header button

**Files:**
- Modify: `index.html:20-31` (header markup)
- Modify: `style.css` (new `.chat-cta` rule, placed after the `.sort-by`/`#sort-select` block around line 194)
- Modify: `app-sqlite.js:238-268` (`initializeUI`) and a new function inserted after `initializeMobileFilters()` (`app-sqlite.js:270-290`)

**Interfaces:**
- Consumes: `#search-input`'s live `.value` at click time (element created dynamically by `setupSearchBox()`, `app-sqlite.js:308-317` — already relied on elsewhere via `document.getElementById('search-input')`, e.g. `app-sqlite.js:980`).
- Produces: navigation to `chat.html?q=<urlencoded text>` (if the search box has text) or plain `chat.html` (if empty). Task 3 consumes the `q` param on the `chat.html` side.

- [ ] **Step 1: Add the `.chat-cta` CSS rule to `style.css`**

Insert after the `#sort-select` rule (`style.css:186-194`), before the blank-line-separated `.stats` rule:

```css
.chat-cta {
    display: flex;
    align-items: center;
    gap: 5px;
    background: #b71c1c;
    color: white;
    border: none;
    border-radius: 20px;
    padding: 0.5em 1em;
    font-size: 0.9em;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    margin-right: 1em;
}

.chat-cta:hover {
    background: #9a1717;
}

.chat-cta .material-symbols-rounded {
    color: white;
}
```

- [ ] **Step 2: Add the button markup to `index.html`**

Current `index.html:20-31`:

```html
  <header class="search">
    <img class="logo"
      src="..."
      alt="Red meeple logo" height="36" width="36">
    <div class="search-box" id="search-box"></div>
    <label for="sort-by">Sort by:</label>
    <div class="sort-by" id="sort-by"></div>
    <div class="stats" id="stats"></div>
    <button id="mobile-filter-toggle" class="mobile-filter-toggle" aria-label="Toggle filters">
      <span class="material-symbols-rounded">filter_list</span>
    </button>
  </header>
```

Insert the new button right after the `search-box` div (keep the `img.logo` and its full `src` attribute exactly as-is — only the line after `</div>` closing `search-box` changes):

```html
    <div class="search-box" id="search-box"></div>
    <button id="chat-cta" class="chat-cta" type="button">
      <span class="material-symbols-rounded icon-small">smart_toy</span>
      Ask the assistant
    </button>
    <label for="sort-by">Sort by:</label>
```

- [ ] **Step 3: Manually verify the button renders styled correctly**

Run `python3 -m http.server 8000` (if not already running) and open `http://localhost:8000/index.html`.

Expected: a red pill-shaped "Ask the assistant" button with a robot icon appears in the header, right after the search box. Clicking it does nothing yet (no listener attached) — that's expected until Step 5.

- [ ] **Step 4: Add the click handler in `app-sqlite.js`**

Insert a new function right after `initializeMobileFilters()` closes (`app-sqlite.js:290`, the lone closing `}` before the two blank lines and `function handleMoreButtonClick`):

```js
function initializeChatCta() {
  const button = document.getElementById('chat-cta');
  if (!button) return;

  button.addEventListener('click', () => {
    const text = document.getElementById('search-input')?.value.trim() || '';
    window.location.href = text
      ? `chat.html?q=${encodeURIComponent(text)}`
      : 'chat.html';
  });
}
```

Then call it from `initializeUI()`. Current `app-sqlite.js:267`:

```js
  initializeMobileFilters();
}
```

Replace with:

```js
  initializeMobileFilters();
  initializeChatCta();
}
```

- [ ] **Step 5: Manually verify the click behavior**

Reload `http://localhost:8000/index.html`. Type `wingspan` into the search box, then click "Ask the assistant".

Expected: the browser navigates to `chat.html?q=wingspan` (visible in the address bar; the page itself will show a loading/error state locally since there's no local Worker to answer `/api/chat` — that's expected and covered in Task 3).

Go back, clear the search box, click "Ask the assistant" again.

Expected: navigates to plain `chat.html` (no `?q=` in the address bar).

- [ ] **Step 6: Commit**

```bash
git add index.html style.css app-sqlite.js
git commit -m "feat: add general ask-the-assistant button to catalog header"
```

---

### Task 3: `chat.html` reads `bgg_id`/`name`/`q` on load

**Files:**
- Modify: `chat.html:614-618` (init block)

**Interfaces:**
- Consumes: `bgg_id` + `name` params (produced by Task 1) and `q` param (produced by Task 2), read from `location.search`. Also consumes existing `chat.html` functions: `loadGames()` (`chat.html:325-346`, returns a Promise resolving to a count, populates module-level `allGames` from the raw `/api/games` JSON), `gameLabel(g)` (`chat.html:321-323`), `startDeepDive(baseSlug, baseLabel, expansionSlugs, expansionLabels)` (`chat.html:464-480`), `triggerOpeningMessage()` (`chat.html:608-612`), `sendMessage(userText)` (`chat.html:349` onward), and the module-level `allGames` array. Each entry has `.slug` and `.base_game_slug` (both explicitly read in `chat.html:330-339`'s dropdown-population code) plus `.bgg_id` (present on the raw catalog JSON served verbatim by `handleGetGames`, `worker/src/index.js:538-544` — the catalog is built by `mybgg-wiki/scripts/build_catalog.py`, outside this repo, per `README-CHAT.md:33-34`; `worker/src/index.js:100`'s `minimizeGame` is a separate code path used only for the LLM prompt, not for `/api/games`. Not itself read anywhere in current `chat.html` code — this task is the first consumer of it there).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Replace the init block**

Current `chat.html:614-618`:

```js
  // ── Init ───────────────────────────────────────────────────────────────────
  (async () => {
    const count = await loadGames();
    triggerOpeningMessage();
  })();
```

Replace with:

```js
  // ── Init ───────────────────────────────────────────────────────────────────
  (async () => {
    await loadGames();
    const params = new URLSearchParams(location.search);
    const bggId = params.get('bgg_id');
    const name = params.get('name');
    const q = params.get('q');

    if (bggId) {
      const game = allGames.find((g) => !g.base_game_slug && String(g.bgg_id) === bggId);
      if (game) {
        document.getElementById('game-select').value = game.slug;
        startDeepDive(game.slug, gameLabel(game), [], []);
        return;
      }
      triggerOpeningMessage();
      if (name) sendMessage(currentLanguage === 'en' ? `Tell me about ${name}` : `Cuéntame sobre ${name}`);
      return;
    }

    triggerOpeningMessage();
    if (q) sendMessage(q);
  })();
```

- [ ] **Step 2: Manually verify the no-match fallback path locally (no live Worker needed)**

Run `python3 -m http.server 8000` from the repo root, open `http://localhost:8000/chat.html?bgg_id=999999&name=Test%20Game`, and open the browser DevTools console.

Expected: no JS errors in the console. `loadGames()` will fail locally (no `/api/games` to hit from a plain static server — this is expected, matches the existing local dev limitation for `chat.html`, unrelated to this change), the game selector shows its existing "No se pudo cargar la lista de juegos." error, but the fallback branch still runs: the discovery opening message appears, followed by a user message bubble reading "Tell me about Test Game" (English, since `currentLanguage` defaults to `'es'` — expect the Spanish variant "Cuéntame sobre Test Game" instead), which then shows a connection error bubble (also expected locally, since `/api/chat` isn't reachable either).

- [ ] **Step 3: Manually verify the `q` fallback path locally**

Open `http://localhost:8000/chat.html?q=Juegos%20para%204%20jugadores`.

Expected: same pattern — discovery opening message, then a user bubble reading "Juegos para 4 jugadores", then a local connection error (expected, no live Worker).

- [ ] **Step 4: Manually verify plain load still works (regression check)**

Open `http://localhost:8000/chat.html` with no query string.

Expected: identical behavior to before this change — discovery opening message only, no auto-sent message, game selector attempts to load and shows the same pre-existing local error.

- [ ] **Step 5: Commit**

```bash
git add chat.html
git commit -m "feat: start chat from catalog game links and search-box handoff"
```

---

## Post-implementation note (not a task — informational)

Steps 2-4 in Task 3 can only exercise the *branching logic* locally, because `chat.html`'s `WORKER_URL` is intentionally same-origin (`chat.html:222`) and there's no local Cloudflare Worker to answer `/api/games` or `/api/chat` from a plain `python -m http.server`. To verify the **match-found branch** (a `bgg_id` that exists in the live wiki catalog lands directly in deep-dive, with no expansions pre-selected) end-to-end, this needs to run against the real Worker — either by deploying (`git push` to `master`, which auto-deploys the static site via GitHub Pages per this repo's existing setup — the Worker itself doesn't need redeploying since `worker/src/index.js` isn't touched) and testing on `https://bgg.cardila.com`, or by temporarily pointing `WORKER_URL` at the deployed Worker's own URL for a local-only check and reverting before commit. Do not commit a non-empty `WORKER_URL`. Deploying is a user decision outside the scope of this plan — ask before pushing.

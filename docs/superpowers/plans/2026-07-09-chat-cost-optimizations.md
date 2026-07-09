# Chat Cost Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce chat cost/latency per the validated design in `docs/superpowers/specs/2026-07-09-chat-cost-optimizations-design.md` — migrate Gemini's tool-calling rounds to `gemini-3.1-flash-lite` with pinned minimal reasoning, strip unneeded catalog fields before they hit the LLM system prompt, and cap/clean BGG forum thread content before it hits the LLM.

**Architecture:** Three independent, additive changes to the existing hybrid Gemini (tool-calling) + DeepSeek (synthesis) chat worker. No change to the round-based control flow (`runChatCompletionStream`), no new secrets, no new dependencies.

**Tech Stack:** Cloudflare Workers, vanilla JS (ES modules), Vitest.

## Global Constraints

- No new npm dependencies — everything is native JS (`String.replace`, `Array.slice`, `Array.map`).
- No changes to `wrangler.toml` or secrets — `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` already exist.
- `handleGetGames` (`worker/src/index.js:401`) must keep returning the catalog exactly as stored in KV — `chat.html` depends on `slug`, `base_game_slug`, and `expansions[].slug` to run its game/expansion selector.
- Do not modify `MAX_TOOL_ROUNDS`, `MAX_TOOL_CALLS_PER_ROUND`, or the retry/fallback machinery (`attemptBufferedRoundWithRetry`, `isIncompleteStream`, `looksLikeLeakedToolCall`, `noMoreToolsNote`).
- Run tests from the `worker/` directory: `npm test` (= `vitest run`). To run a single file: `npx vitest run test/<file>.test.js`.
- Follow existing test conventions exactly: `vi.stubGlobal('fetch', ...)` + `afterEach(() => vi.unstubAllGlobals())` for `bggTools.test.js`-style tests; `fakeSSEResponse`/`readAllText` from `worker/test/sseHelpers.js` for `runChatCompletion.test.js`-style tests.

---

### Task 1: Migrate Gemini tool-calling rounds to `gemini-3.1-flash-lite` with minimal reasoning effort

**Files:**
- Modify: `worker/src/index.js:101-119` (`callGemini`)
- Test: `worker/test/runChatCompletion.test.js`

**Interfaces:**
- Consumes: nothing new — `callGemini(messages, apiKey, { tools })` keeps its existing signature and return type (a `Response` whose body is an SSE stream in OpenAI-compatible format).
- Produces: nothing new — this task only changes the JSON body sent to Gemini's endpoint.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('runChatCompletion', ...)` block in `worker/test/runChatCompletion.test.js`, right after the `'replays buffered content when no tool call is requested'` test (after line 135):

```javascript
  it('sends gemini-3.1-flash-lite with minimal reasoning effort in round 1', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('gemini-3.1-flash-lite');
    expect(body.reasoning_effort).toBe('minimal');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `worker/`): `npx vitest run test/runChatCompletion.test.js -t "minimal reasoning effort"`
Expected: FAIL — `expect(body.model).toBe('gemini-3.1-flash-lite')` fails because the current model is `'gemini-2.5-flash-lite'` and `body.reasoning_effort` is `undefined`.

- [ ] **Step 3: Update `callGemini`**

Replace the body of `callGemini` in `worker/src/index.js` (lines 101-102):

```javascript
async function callGemini(messages, apiKey, { tools } = {}) {
  const body = {
    model: 'gemini-3.1-flash-lite',
    messages,
    stream: true,
    reasoning_effort: 'minimal',
  };
  if (tools) body.tools = tools;
```

(The rest of the function — the `fetch` call, error handling, return — is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runChatCompletion.test.js`
Expected: PASS — all tests in the file pass, including the new one. (Confirms the model/param change doesn't break any of the existing tool-calling, retry, or fallback tests, since those only assert on `finish_reason`/`delta` shape, not on the request body's `model` field.)

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js worker/test/runChatCompletion.test.js
git commit -m "feat: migrate Gemini tool-calling rounds to gemini-3.1-flash-lite with minimal reasoning effort"
```

- [ ] **Step 6: Manually verify real tool-calling still works**

This model swap can't be fully verified by mocked tests — it needs one real call to confirm Gemini still returns `finish_reason: "tool_calls"` reliably with `gemini-3.1-flash-lite` + `reasoning_effort: "minimal"`.

Run: `cd worker && npm run dev` (starts `wrangler dev`), then in another terminal:

```bash
curl -N -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"message":"¿qué expansiones tiene Wingspan?","mode":"discovery","language":"es"}'
```

Expected: the SSE stream includes a `{"status":"searching"}` or `{"status":"details"}` frame (proof a tool call fired) followed by token frames forming a real answer, ending in `data: [DONE]`. If the stream instead goes straight to a generic answer with no `status` frames beyond `"thinking"`/`"writing"`, Gemini didn't call tools — investigate before moving on (don't proceed to Task 2 with this unverified).

---

### Task 2: Minimize the catalog before it enters the discovery system prompt

**Files:**
- Modify: `worker/src/index.js` (add `minimizeGame`, wire it into `handleChat`, export it)
- Test: `worker/test/minimizeGame.test.js` (new)

**Interfaces:**
- Consumes: a game object with the real production catalog schema: `{ slug, name, players, weight, playing_time, mechanics, categories, edition, status, rank, base_game_slug, expansions }`, where `expansions` is an array of objects with the same shape.
- Produces: `minimizeGame(game: object, isNested?: boolean): object` — exported from `worker/src/index.js` for direct unit testing. Returns `{ name, players, weight, mechanics, categories, status, rank?, expansions? }` (see Step 3 for exact shape rules).

- [ ] **Step 1: Write the failing tests**

Create `worker/test/minimizeGame.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { minimizeGame } from '../src/index.js';

describe('minimizeGame', () => {
  it('keeps only the fields the discovery prompt needs', () => {
    const game = {
      slug: 'wingspan-2019',
      name: 'Wingspan',
      players: '1-5',
      weight: '2.4',
      playing_time: '',
      mechanics: ['Engine Building'],
      categories: ['Animals'],
      edition: '2019',
      status: 'owned',
      rank: '23',
      base_game_slug: '',
      expansions: [],
    };

    expect(minimizeGame(game)).toEqual({
      name: 'Wingspan',
      players: '1-5',
      weight: '2.4',
      mechanics: ['Engine Building'],
      categories: ['Animals'],
      status: 'owned',
      rank: '23',
    });
  });

  it('omits the expansions key entirely when the game has none', () => {
    const game = {
      slug: 'foo-2020',
      name: 'Foo',
      players: '2-4',
      weight: '1.0',
      playing_time: '',
      mechanics: [],
      categories: [],
      edition: '2020',
      status: 'owned',
      rank: '9999',
      base_game_slug: '',
      expansions: [],
    };

    expect(minimizeGame(game)).not.toHaveProperty('expansions');
  });

  it('minimizes nested expansions without recursing into their own rank or expansions', () => {
    const game = {
      slug: 'wingspan-2019',
      name: 'Wingspan',
      players: '1-5',
      weight: '2.4',
      playing_time: '',
      mechanics: ['Engine Building'],
      categories: ['Animals'],
      edition: '2019',
      status: 'owned',
      rank: '23',
      base_game_slug: '',
      expansions: [
        {
          slug: 'wingspan-european-expansion-2019',
          name: 'Wingspan: European Expansion',
          players: '1-5',
          weight: '2.5',
          playing_time: '',
          mechanics: ['Engine Building'],
          categories: ['Animals'],
          edition: '2019',
          status: 'owned',
          rank: 'Not Ranked',
          base_game_slug: 'wingspan-2019',
          expansions: [],
        },
      ],
    };

    expect(minimizeGame(game)).toEqual({
      name: 'Wingspan',
      players: '1-5',
      weight: '2.4',
      mechanics: ['Engine Building'],
      categories: ['Animals'],
      status: 'owned',
      rank: '23',
      expansions: [
        {
          name: 'Wingspan: European Expansion',
          players: '1-5',
          weight: '2.5',
          mechanics: ['Engine Building'],
          categories: ['Animals'],
          status: 'owned',
        },
      ],
    });
  });

  it('handles an empty catalog', () => {
    expect([].map((g) => minimizeGame(g))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `worker/`): `npx vitest run test/minimizeGame.test.js`
Expected: FAIL with an import error — `minimizeGame` is not exported from `../src/index.js`.

- [ ] **Step 3: Implement `minimizeGame` in `worker/src/index.js`**

Add this function right before `function sseError(request, message, status = 200) {` (currently line 61):

```javascript
function minimizeGame(game, isNested = false) {
  const out = {
    name: game.name,
    players: game.players,
    weight: game.weight,
    mechanics: game.mechanics,
    categories: game.categories,
    status: game.status,
  };
  if (!isNested) {
    out.rank = game.rank;
    if (game.expansions?.length) {
      out.expansions = game.expansions.map((e) => minimizeGame(e, true));
    }
  }
  return out;
}
```

- [ ] **Step 4: Export `minimizeGame`**

In `worker/src/index.js`, update the final export line (currently line 551):

```javascript
export { callDeepSeek, parseDeepSeekStream, streamDeepSeek, runChatCompletion, statusForToolCalls, minimizeGame };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/minimizeGame.test.js`
Expected: PASS — all 4 tests pass.

- [ ] **Step 6: Wire `minimizeGame` into `handleChat`'s discovery branch**

In `worker/src/index.js`, replace lines 473-476:

```javascript
  if (mode === 'discovery') {
    const catalog = (await env.WIKI.get('catalog')) || '[]';
    const systemBase = SYSTEM_PROMPTS.discovery[language] ?? SYSTEM_PROMPTS.discovery.es;
    systemContent = `${systemBase}\n\nUser's game catalog (JSON):\n${catalog}`;
```

with:

```javascript
  if (mode === 'discovery') {
    const catalogRaw = (await env.WIKI.get('catalog')) || '[]';
    const minimizedCatalog = JSON.parse(catalogRaw).map((g) => minimizeGame(g));
    const systemBase = SYSTEM_PROMPTS.discovery[language] ?? SYSTEM_PROMPTS.discovery.es;
    systemContent = `${systemBase}\n\nUser's game catalog (JSON):\n${JSON.stringify(minimizedCatalog)}`;
```

Note: `handleGetGames` (line ~401-407) is untouched — it must keep serving the raw catalog string exactly as-is, since `chat.html` reads `slug`/`base_game_slug`/`expansions[].slug` from `/api/games` to build its selector.

- [ ] **Step 7: Run the full worker test suite**

Run: `npm test`
Expected: PASS — all existing test files (`bggTools.test.js`, `deepDiveContext.test.js`, `deepseekStream.test.js`, `rateLimiter.test.js`, `runChatCompletion.test.js`, `statusForToolCalls.test.js`, `minimizeGame.test.js`) pass. No existing test reads `env.WIKI.get('catalog')` directly, so this change should not affect any of them.

- [ ] **Step 8: Commit**

```bash
git add worker/src/index.js worker/test/minimizeGame.test.js
git commit -m "feat: minimize catalog fields before injecting into discovery system prompt"
```

- [ ] **Step 9: Manually verify `/api/games` is unaffected**

Run: `cd worker && npm run dev`, then in another terminal:

```bash
curl -s http://localhost:8787/api/games | head -c 500
```

Expected: output still includes `"slug"`, `"base_game_slug"`, `"edition"`, `"playing_time"` fields — i.e., the raw catalog shape, unminimized. This confirms `handleGetGames` was not accidentally touched.

---

### Task 3: Clean and cap BGG forum thread content (`bgg_get_thread`)

**Files:**
- Modify: `worker/src/bggTools.js:174-188` (`getThread`)
- Test: `worker/test/bggTools.test.js`

**Interfaces:**
- Consumes: nothing new — same BGG XML API response shape already parsed by `bggFetch`/`asArray`.
- Produces: nothing new — `getThread`'s return shape (`{ id, subject, posts: [{ author, date, text }] }`) is unchanged; only the *content* of `text` and the *count* of `posts` change.

- [ ] **Step 1: Write the failing tests**

In `worker/test/bggTools.test.js`, inside the existing `describe('executeBggTool: bgg_get_thread', ...)` block (after line 201, right before the `'returns an error when the thread does not exist'` test), add:

```javascript
  it('strips [quote=user]...[/quote] blocks, including the attribution tag', async () => {
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="1">
        <subject>Rules question</subject>
        <link>l</link>
        <articles>
          <article id="1" username="user1" link="l" postdate="2026-01-01" editdate="2026-01-01" numedits="0">
            <subject>Rules question</subject>
            <body><![CDATA[[quote=user2]You always draw first[/quote]Actually that's wrong, you draw last.]]></body>
          </article>
        </articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(result.posts[0].text).toBe("Actually that's wrong, you draw last.");
  });

  it('strips [q]...[/q] blocks with no attribution', async () => {
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="1">
        <subject>Rules question</subject>
        <link>l</link>
        <articles>
          <article id="1" username="user1" link="l" postdate="2026-01-01" editdate="2026-01-01" numedits="0">
            <subject>Rules question</subject>
            <body><![CDATA[[q]Some earlier post[/q]I agree with this.]]></body>
          </article>
        </articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(result.posts[0].text).toBe('I agree with this.');
  });

  it('truncates posts longer than 1500 characters', async () => {
    const longText = 'a'.repeat(2000);
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="1">
        <subject>Long post</subject>
        <link>l</link>
        <articles>
          <article id="1" username="user1" link="l" postdate="2026-01-01" editdate="2026-01-01" numedits="0">
            <subject>Long post</subject>
            <body><![CDATA[${longText}]]></body>
          </article>
        </articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(result.posts[0].text).toBe(`${'a'.repeat(1500)}…`);
  });

  it('limits results to the first 10 posts when the thread has more', async () => {
    const articles = Array.from({ length: 12 }, (_, i) => `
          <article id="${i}" username="user${i}" link="l" postdate="2026-01-0${(i % 9) + 1}" editdate="2026-01-01" numedits="0">
            <subject>Re: Long thread</subject>
            <body><![CDATA[Post number ${i}]]></body>
          </article>`).join('');
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="12">
        <subject>Long thread</subject>
        <link>l</link>
        <articles>${articles}</articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(result.posts).toHaveLength(10);
    expect(result.posts[0].text).toBe('Post number 0');
    expect(result.posts[9].text).toBe('Post number 9');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `worker/`): `npx vitest run test/bggTools.test.js -t "quote"`
Expected: FAIL — current `getThread` returns the raw body including `[quote=...]`/`[q]` markup, and doesn't truncate or cap post count.

- [ ] **Step 3: Implement the cleanup in `worker/src/bggTools.js`**

Add these two helper functions right before `async function getThread` (currently line 174):

```javascript
const MAX_THREAD_POSTS = 10;
const MAX_POST_CHARS = 1500;

function stripQuotes(text) {
  // BGG supports [q]/[/q] (native) and [quote]/[/quote] (a synonym added later),
  // both with or without attribution (e.g. [q=user], [quote=user]).
  return text.replace(/\[(?:q|quote)(?:=[^\]]*)?\]([\s\S]*?)\[\/(?:q|quote)\]/gi, '').trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
```

Then replace the body of `getThread` (currently lines 174-188):

```javascript
async function getThread({ thread_id }, token) {
  const data = await bggFetch('/thread', { id: thread_id }, token);
  const thread = data.thread;
  if (!thread || !thread.subject) throw new Error(`Thread ${thread_id} not found`);
  const articles = asArray(thread.articles?.article);
  return {
    id: Number(thread['@_id']),
    subject: thread.subject,
    posts: articles.slice(0, MAX_THREAD_POSTS).map((article) => ({
      author: article['@_username'],
      date: article['@_postdate'],
      text: truncate(stripQuotes(typeof article.body === 'string' ? article.body : ''), MAX_POST_CHARS),
    })),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/bggTools.test.js`
Expected: PASS — all tests in the file pass, including the 4 new ones and the pre-existing `'returns the thread subject and each post'` test (its 2 short, unquoted posts are unaffected by `stripQuotes`/`truncate`/`slice`).

- [ ] **Step 5: Run the full worker test suite**

Run: `npm test`
Expected: PASS — no other file depends on `getThread`'s internals.

- [ ] **Step 6: Commit**

```bash
git add worker/src/bggTools.js worker/test/bggTools.test.js
git commit -m "feat: strip forum quote markup and cap post count/length in bgg_get_thread"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 (model + reasoning_effort), Task 2 (minimizeGame + wiring + handleGetGames untouched), Task 3 (stripQuotes + truncate + post cap) — all three spec sections have a corresponding task with executable steps.
- **Placeholders:** none — every step has literal code, exact file paths/line numbers, and exact run commands with expected output.
- **Type/name consistency:** `minimizeGame(game, isNested)` signature and returned shape match between the design spec, the test file, and the implementation step. `stripQuotes`/`truncate`/`MAX_THREAD_POSTS`/`MAX_POST_CHARS` names match between spec and plan.

# BGG Live Lookup (MCP-lite tool-calling) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the DeepSeek-powered chat in `worker/src/index.js` the ability to call live BoardGameGeek data (game search/details, forum/thread content) via OpenAI-style tool-calling, for questions the ingested wiki/catalog doesn't cover.

**Architecture:** A new `worker/src/bggTools.js` module exposes 4 tool schemas and an `executeBggTool` dispatcher that calls BGG's `xmlapi2` and parses XML responses with `fast-xml-parser`. `worker/src/index.js`'s streaming internals are refactored into shared `callDeepSeek`/`parseDeepSeekStream` helpers, then a new `runChatCompletion` orchestrates a single buffered "does this need a tool" round, followed by — only if the model requested one — a live-streamed follow-up round with tool results injected.

**Tech Stack:** Cloudflare Workers, vitest, `fast-xml-parser` (new dependency), DeepSeek's OpenAI-compatible chat completions API.

**Reference spec:** `docs/superpowers/specs/2026-07-07-bgg-live-lookup-design.md`

## Global Constraints

- Only files under `worker/` change; `chat.html` requires no changes.
- BGG auth: `Authorization: Bearer <BGG_TOKEN>` against `https://www.boardgamegeek.com/xmlapi2`, same scheme as `scripts/gamecache/bgg_client.py`.
- Max 3 tool calls executed per round (`MAX_TOOL_CALLS_PER_ROUND = 3`).
- Max 1 tool-calling round per chat turn — the follow-up (round 2) call never receives a `tools` param, so a further round is structurally impossible.
- No caching and no retries for BGG API calls — a failure becomes `{error}` fed back to the model, nothing more.
- No new KV namespace, and no changes to the existing rate limiter (`worker/src/rateLimiter.js`).
- All tests mock `fetch`; no real network calls in the test suite.

---

### Task 1: `bggTools.js` — game search & details tools

**Files:**
- Modify: `worker/package.json`
- Create: `worker/src/bggTools.js`
- Create: `worker/test/sseHelpers.js`
- Create: `worker/test/bggTools.test.js`

**Interfaces:**
- Produces: `BGG_TOOL_DEFINITIONS` — array of 4 OpenAI-style tool schemas (all 4 tools declared now; `bgg_search_forum`/`bgg_get_thread` executors are wired in Task 2).
- Produces: `executeBggTool(name, args, token)` — async function returning `{ result }` or `{ error }`, never throws. In this task it handles `bgg_search_game` and `bgg_get_game_details`; unknown names return `{ error: 'Unknown tool: <name>' }`.
- Consumes (Task 2 depends on this): the same `executeBggTool` switch statement, extended with two more cases.

- [ ] **Step 1: Add the `fast-xml-parser` dependency**

```bash
cd worker && npm install fast-xml-parser
```

Verify `worker/package.json` now lists `fast-xml-parser` under `"dependencies"`.

- [ ] **Step 2: Create the shared SSE test fixture helper**

```js
// worker/test/sseHelpers.js
export function fakeSSEResponse(dataLines, { ok = true, status = 200 } = {}) {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  return {
    ok,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
  };
}
```

- [ ] **Step 3: Write the failing tests for `bgg_search_game` and `bgg_get_game_details`**

```js
// worker/test/bggTools.test.js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BGG_TOOL_DEFINITIONS, executeBggTool } from '../src/bggTools.js';

function fakeXmlResponse(xml, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => xml };
}

describe('BGG_TOOL_DEFINITIONS', () => {
  it('declares all 4 tools by name', () => {
    const names = BGG_TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names).toEqual([
      'bgg_search_game',
      'bgg_get_game_details',
      'bgg_search_forum',
      'bgg_get_thread',
    ]);
  });
});

describe('executeBggTool: bgg_search_game', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns matching games with id, name, and year', async () => {
    const xml = `<?xml version="1.0"?>
      <items total="1" termsofuse="x">
        <item type="boardgame" id="266192">
          <name type="primary" value="Wingspan"/>
          <yearpublished value="2019"/>
        </item>
      </items>`;
    const mockFetch = vi.fn().mockResolvedValue(fakeXmlResponse(xml));
    vi.stubGlobal('fetch', mockFetch);

    const { result, error } = await executeBggTool('bgg_search_game', { query: 'Wingspan' }, 'tok123');

    expect(error).toBeUndefined();
    expect(result).toEqual([{ id: 266192, type: 'boardgame', name: 'Wingspan', year: 2019 }]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/search?query=Wingspan');
    expect(opts.headers.Authorization).toBe('Bearer tok123');
  });

  it('returns an empty array when BGG has no matches', async () => {
    const xml = `<?xml version="1.0"?><items total="0" termsofuse="x"></items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_search_game', { query: 'zzz-nonexistent' }, 'tok123');
    expect(result).toEqual([]);
  });
});

describe('executeBggTool: bgg_get_game_details', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns rating, weight, players, mechanics, categories, expansions', async () => {
    const xml = `<?xml version="1.0"?>
      <items termsofuse="x">
        <item type="boardgame" id="266192">
          <name type="primary" sortindex="1" value="Wingspan"/>
          <name type="alternate" sortindex="1" value="Wingspan Alt"/>
          <yearpublished value="2019"/>
          <minplayers value="1"/>
          <maxplayers value="5"/>
          <playingtime value="70"/>
          <link type="boardgamecategory" id="1024" value="Animals"/>
          <link type="boardgamemechanic" id="2040" value="Engine Building"/>
          <link type="boardgameexpansion" id="300217" value="Wingspan: European Expansion"/>
          <statistics>
            <ratings>
              <average value="8.1"/>
              <averageweight value="2.4"/>
            </ratings>
          </statistics>
        </item>
      </items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_game_details', { bgg_id: 266192 }, 'tok123');

    expect(error).toBeUndefined();
    expect(result).toEqual({
      id: 266192,
      name: 'Wingspan',
      year: 2019,
      min_players: 1,
      max_players: 5,
      playing_time: 70,
      rating: 8.1,
      weight: 2.4,
      categories: ['Animals'],
      mechanics: ['Engine Building'],
      expansions: [{ id: 300217, name: 'Wingspan: European Expansion' }],
    });
  });

  it('returns an error when the game id does not exist', async () => {
    const xml = `<?xml version="1.0"?><items termsofuse="x"></items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_game_details', { bgg_id: 999999999 }, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('Game 999999999 not found');
  });
});

describe('executeBggTool: errors and unknown tools', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns an error object when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { result, error } = await executeBggTool('bgg_search_game', { query: 'x' }, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('network down');
  });

  it('returns an auth error on a 401 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse('', { ok: false, status: 401 })));
    const { error } = await executeBggTool('bgg_search_game', { query: 'x' }, 'tok123');
    expect(error).toBe('BGG_TOKEN invalido o expirado');
  });

  it('returns a generic error on a 5xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse('', { ok: false, status: 503 })));
    const { error } = await executeBggTool('bgg_search_game', { query: 'x' }, 'tok123');
    expect(error).toBe('BGG API error: 503');
  });

  it('returns an error for an unknown tool name', async () => {
    const { error } = await executeBggTool('bgg_nonexistent', {}, 'tok123');
    expect(error).toBe('Unknown tool: bgg_nonexistent');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
cd worker && npx vitest run test/bggTools.test.js
```

Expected: FAIL — `worker/src/bggTools.js` does not exist yet.

- [ ] **Step 5: Implement `worker/src/bggTools.js`**

```js
import { XMLParser } from 'fast-xml-parser';

const BASE_URL = 'https://www.boardgamegeek.com/xmlapi2';

const REPEATABLE_PATHS = new Set([
  'items.item',
  'items.item.name',
  'items.item.link',
  'forumlist.forum',
  'forum.threads.thread',
  'thread.articles.article',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (_name, jpath) => REPEATABLE_PATHS.has(jpath),
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function bggFetch(path, params, token) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 401) {
    throw new Error('BGG_TOKEN invalido o expirado');
  }
  if (!response.ok) {
    throw new Error(`BGG API error: ${response.status}`);
  }
  const text = await response.text();
  return parser.parse(text);
}

export const BGG_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'bgg_search_game',
      description: 'Search BoardGameGeek for games by name. Returns id, name, and year for each match.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Game name to search for' },
          type: {
            type: 'string',
            enum: ['boardgame', 'boardgameexpansion', 'all'],
            description: 'Restrict to base games, expansions, or all types. Defaults to all.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bgg_get_game_details',
      description: 'Get rating, complexity weight, player count, mechanics, categories, and expansions for a specific BGG game id.',
      parameters: {
        type: 'object',
        properties: {
          bgg_id: { type: 'integer', description: 'BoardGameGeek numeric game id' },
        },
        required: ['bgg_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bgg_search_forum',
      description: "Search a game's BGG forums for threads whose subject matches a term (rules questions, fan variants, unofficial solo modes, etc).",
      parameters: {
        type: 'object',
        properties: {
          bgg_id: { type: 'integer', description: 'BoardGameGeek numeric game id' },
          query: { type: 'string', description: 'Term to look for in thread subjects, e.g. "solo variant" or "rules question"' },
        },
        required: ['bgg_id', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bgg_get_thread',
      description: 'Get the full post content of a specific BGG forum thread by id.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'integer', description: 'BoardGameGeek numeric thread id' },
        },
        required: ['thread_id'],
      },
    },
  },
];

async function searchGame({ query, type }, token) {
  const params = { query };
  if (type && type !== 'all') params.type = type;
  const data = await bggFetch('/search', params, token);
  const items = asArray(data.items?.item);
  return items.map((item) => {
    const names = asArray(item.name);
    return {
      id: Number(item['@_id']),
      type: item['@_type'],
      name: names.find((n) => n['@_type'] === 'primary')?.['@_value'] ?? names[0]?.['@_value'] ?? null,
      year: item.yearpublished?.['@_value'] ? Number(item.yearpublished['@_value']) : null,
    };
  });
}

async function getGameDetails({ bgg_id }, token) {
  const data = await bggFetch('/thing', { id: bgg_id, stats: 1 }, token);
  const item = asArray(data.items?.item)[0];
  if (!item) throw new Error(`Game ${bgg_id} not found`);

  const names = asArray(item.name);
  const links = asArray(item.link);
  const byType = (t) =>
    links.filter((l) => l['@_type'] === t).map((l) => ({ id: Number(l['@_id']), name: l['@_value'] }));

  return {
    id: Number(item['@_id']),
    name: names.find((n) => n['@_type'] === 'primary')?.['@_value'] ?? names[0]?.['@_value'] ?? null,
    year: item.yearpublished?.['@_value'] ? Number(item.yearpublished['@_value']) : null,
    min_players: item.minplayers?.['@_value'] ? Number(item.minplayers['@_value']) : null,
    max_players: item.maxplayers?.['@_value'] ? Number(item.maxplayers['@_value']) : null,
    playing_time: item.playingtime?.['@_value'] ? Number(item.playingtime['@_value']) : null,
    rating: item.statistics?.ratings?.average?.['@_value'] ? Number(item.statistics.ratings.average['@_value']) : null,
    weight: item.statistics?.ratings?.averageweight?.['@_value'] ? Number(item.statistics.ratings.averageweight['@_value']) : null,
    categories: byType('boardgamecategory').map((c) => c.name),
    mechanics: byType('boardgamemechanic').map((m) => m.name),
    expansions: byType('boardgameexpansion'),
  };
}

export async function executeBggTool(name, args, token) {
  try {
    switch (name) {
      case 'bgg_search_game':
        return { result: await searchGame(args, token) };
      case 'bgg_get_game_details':
        return { result: await getGameDetails(args, token) };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd worker && npx vitest run test/bggTools.test.js
```

Expected: PASS (all cases in this file — `bgg_search_forum`/`bgg_get_thread` are added in Task 2).

- [ ] **Step 7: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/src/bggTools.js worker/test/sseHelpers.js worker/test/bggTools.test.js
git commit -m "feat: add BGG search and game details tools"
```

---

### Task 2: `bggTools.js` — forum search & thread tools

**Files:**
- Modify: `worker/src/bggTools.js`
- Modify: `worker/test/bggTools.test.js`

**Interfaces:**
- Consumes: `bggFetch`, `asArray`, `BASE_URL`, `parser` from Task 1 (same file, not exported — used internally).
- Produces: `executeBggTool` now also handles `bgg_search_forum` and `bgg_get_thread`. No new exports — `BGG_TOOL_DEFINITIONS` and `executeBggTool` signatures are unchanged from Task 1.

- [ ] **Step 1: Write the failing tests for `bgg_search_forum` and `bgg_get_thread`**

Append to `worker/test/bggTools.test.js`:

```js
describe('executeBggTool: bgg_search_forum', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns threads whose subject matches the query, across all forums', async () => {
    const forumlistXml = `<?xml version="1.0"?>
      <forumlist type="thing" id="266192" termsofuse="x">
        <forum id="1" title="Rules" noposting="0" description="d" numthreads="1" numposts="1" lastpostdate="d"/>
        <forum id="2" title="General" noposting="0" description="d" numthreads="1" numposts="1" lastpostdate="d"/>
      </forumlist>`;
    const rulesForumXml = `<?xml version="1.0"?>
      <forum id="1" title="Rules" numthreads="1" numposts="1" termsofuse="x">
        <threads>
          <thread id="1000" subject="Unofficial solo variant" author="user1" numarticles="2" postdate="d" lastpostdate="d"/>
        </threads>
      </forum>`;
    const generalForumXml = `<?xml version="1.0"?>
      <forum id="2" title="General" numthreads="1" numposts="1" termsofuse="x">
        <threads>
          <thread id="1001" subject="Best insert for the box" author="user2" numarticles="3" postdate="d" lastpostdate="d"/>
        </threads>
      </forum>`;

    const mockFetch = vi.fn((url) => {
      const text = url.includes('/forumlist')
        ? forumlistXml
        : url.includes('id=1')
        ? rulesForumXml
        : generalForumXml;
      return Promise.resolve(fakeXmlResponse(text));
    });
    vi.stubGlobal('fetch', mockFetch);

    const { result, error } = await executeBggTool(
      'bgg_search_forum',
      { bgg_id: 266192, query: 'solo' },
      'tok123'
    );

    expect(error).toBeUndefined();
    expect(result).toEqual([{ id: 1000, subject: 'Unofficial solo variant', author: 'user1', forum: 'Rules' }]);
  });

  it('returns an empty array when nothing matches', async () => {
    const forumlistXml = `<?xml version="1.0"?>
      <forumlist type="thing" id="266192" termsofuse="x">
        <forum id="1" title="Rules" noposting="0" description="d" numthreads="0" numposts="0" lastpostdate="d"/>
      </forumlist>`;
    const rulesForumXml = `<?xml version="1.0"?>
      <forum id="1" title="Rules" numthreads="0" numposts="0" termsofuse="x"><threads></threads></forum>`;

    vi.stubGlobal(
      'fetch',
      vi.fn((url) =>
        Promise.resolve(fakeXmlResponse(url.includes('/forumlist') ? forumlistXml : rulesForumXml))
      )
    );

    const { result } = await executeBggTool('bgg_search_forum', { bgg_id: 266192, query: 'zzz' }, 'tok123');
    expect(result).toEqual([]);
  });
});

describe('executeBggTool: bgg_get_thread', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the thread subject and each post', async () => {
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="2">
        <subject>Unofficial solo variant</subject>
        <link>https://boardgamegeek.com/thread/1000</link>
        <articles>
          <article id="1" username="user1" link="l" postdate="2026-01-01" editdate="2026-01-01" numedits="0">
            <subject>Unofficial solo variant</subject>
            <body><![CDATA[Has anyone tried a solo mode?]]></body>
          </article>
          <article id="2" username="user3" link="l" postdate="2026-01-02" editdate="2026-01-02" numedits="0">
            <subject>Re: Unofficial solo variant</subject>
            <body><![CDATA[Check the Files section.]]></body>
          </article>
        </articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(error).toBeUndefined();
    expect(result).toEqual({
      id: 1000,
      subject: 'Unofficial solo variant',
      posts: [
        { author: 'user1', date: '2026-01-01', text: 'Has anyone tried a solo mode?' },
        { author: 'user3', date: '2026-01-02', text: 'Check the Files section.' },
      ],
    });
  });

  it('returns an error when the thread does not exist', async () => {
    const xml = `<?xml version="1.0"?><error><message>Thread not found</message></error>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_thread', { thread_id: 999999999 }, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('Thread 999999999 not found');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd worker && npx vitest run test/bggTools.test.js
```

Expected: FAIL — `bgg_search_forum` and `bgg_get_thread` still return `Unknown tool`.

- [ ] **Step 3: Implement `searchForum` and `getThread`, wire into `executeBggTool`**

Add to `worker/src/bggTools.js`, above `export async function executeBggTool`:

```js
async function searchForum({ bgg_id, query }, token) {
  const listData = await bggFetch('/forumlist', { id: bgg_id, type: 'thing' }, token);
  const forums = asArray(listData.forumlist?.forum);

  const perForumResults = await Promise.all(
    forums.map(async (forum) => {
      const forumData = await bggFetch('/forum', { id: forum['@_id'] }, token);
      const threads = asArray(forumData.forum?.threads?.thread);
      return threads.map((thread) => ({
        id: Number(thread['@_id']),
        subject: thread['@_subject'],
        author: thread['@_author'],
        forum: forum['@_title'],
      }));
    })
  );

  const term = query.toLowerCase();
  return perForumResults
    .flat()
    .filter((thread) => thread.subject?.toLowerCase().includes(term))
    .slice(0, 10);
}

async function getThread({ thread_id }, token) {
  const data = await bggFetch('/thread', { id: thread_id }, token);
  const thread = data.thread;
  if (!thread || !thread.subject) throw new Error(`Thread ${thread_id} not found`);
  const articles = asArray(thread.articles?.article);
  return {
    id: Number(thread['@_id']),
    subject: thread.subject,
    posts: articles.map((article) => ({
      author: article['@_username'],
      date: article['@_postdate'],
      text: typeof article.body === 'string' ? article.body : '',
    })),
  };
}
```

Update the switch inside `executeBggTool`:

```js
export async function executeBggTool(name, args, token) {
  try {
    switch (name) {
      case 'bgg_search_game':
        return { result: await searchGame(args, token) };
      case 'bgg_get_game_details':
        return { result: await getGameDetails(args, token) };
      case 'bgg_search_forum':
        return { result: await searchForum(args, token) };
      case 'bgg_get_thread':
        return { result: await getThread(args, token) };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd worker && npx vitest run test/bggTools.test.js
```

Expected: PASS (all cases, both tasks' tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/bggTools.js worker/test/bggTools.test.js
git commit -m "feat: add BGG forum search and thread tools"
```

---

### Task 3: Refactor `index.js` streaming internals (no behavior change)

**Files:**
- Modify: `worker/src/index.js:60-126` (the existing `streamDeepSeek` function)
- Create: `worker/test/deepseekStream.test.js`

**Interfaces:**
- Produces: `callDeepSeek(messages, apiKey, { tools })` — async, returns the raw `fetch` `Response` on success, throws `Error('DeepSeek API error: <status>')` on non-2xx.
- Produces: `parseDeepSeekStream(response, onToken)` — async, `onToken` is an async callback invoked with each content-delta string; returns `{ finishReason, toolCalls }` where `toolCalls` is `[{ id, function: { name, arguments } }]` reassembled from chunked deltas.
- Produces: `streamDeepSeek(messages, apiKey, request)` — unchanged external behavior (same as today), now implemented in terms of the two functions above.
- Produces (new, unused until Task 4): `sseFormat(token)`, `replayBufferedAsSSE(tokens, request)`.
- These 5 functions plus `streamDeepSeek` and (in Task 4) `runChatCompletion` are added to a named `export { ... }` at the bottom of `index.js`, alongside the existing `export default { fetch(...) }`, purely so tests can import them directly.

- [ ] **Step 1: Write the failing regression tests**

```js
// worker/test/deepseekStream.test.js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callDeepSeek, parseDeepSeekStream, streamDeepSeek } from '../src/index.js';
import { fakeSSEResponse } from './sseHelpers.js';

async function readAllText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe('callDeepSeek', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends model, messages, and stream:true', async () => {
    const mockFetch = vi.fn().mockResolvedValue(fakeSSEResponse([]));
    vi.stubGlobal('fetch', mockFetch);

    const messages = [{ role: 'user', content: 'hi' }];
    await callDeepSeek(messages, 'key123', {});

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer key123', 'Content-Type': 'application/json' },
      })
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      model: 'deepseek-v4-flash',
      messages,
      stream: true,
    });
  });

  it('includes tools in the body when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(fakeSSEResponse([]));
    vi.stubGlobal('fetch', mockFetch);
    const tools = [{ type: 'function', function: { name: 'x' } }];

    await callDeepSeek([{ role: 'user', content: 'hi' }], 'key123', { tools });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).tools).toEqual(tools);
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeSSEResponse([], { ok: false, status: 500 })));
    await expect(callDeepSeek([{ role: 'user', content: 'hi' }], 'key123', {})).rejects.toThrow(
      'DeepSeek API error: 500'
    );
  });
});

describe('parseDeepSeekStream', () => {
  it('accumulates content tokens and returns finishReason "stop"', async () => {
    const response = fakeSSEResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hola' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: ' mundo' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);

    const tokens = [];
    const result = await parseDeepSeekStream(response, async (t) => tokens.push(t));

    expect(tokens).toEqual(['Hola', ' mundo']);
    expect(result).toEqual({ finishReason: 'stop', toolCalls: [] });
  });

  it('reconstructs chunked tool_calls and returns finishReason "tool_calls"', async () => {
    const response = fakeSSEResponse([
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bgg_search_game', arguments: '' } }] } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Wingspan"}' } }] } }],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ]);

    const result = await parseDeepSeekStream(response, async () => {});

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', function: { name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' } },
    ]);
  });
});

describe('streamDeepSeek', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams content tokens as SSE frames ending in [DONE]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hola' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      )
    );

    const fakeRequest = new Request('https://example.com/api/chat', {
      headers: { Origin: 'https://bgg.cardila.com' },
    });
    const response = await streamDeepSeek([{ role: 'user', content: 'hola' }], 'key123', fakeRequest);
    const text = await readAllText(response);

    expect(text).toContain('data: {"token":"Hola"}');
    expect(text).toContain('data: [DONE]');
  });

  it('rejects when the DeepSeek call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeSSEResponse([], { ok: false, status: 500 })));
    const fakeRequest = new Request('https://example.com/api/chat');

    await expect(
      streamDeepSeek([{ role: 'user', content: 'hola' }], 'key123', fakeRequest)
    ).rejects.toThrow('DeepSeek API error: 500');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd worker && npx vitest run test/deepseekStream.test.js
```

Expected: FAIL — `callDeepSeek` and `parseDeepSeekStream` are not exported yet (`streamDeepSeek` exists but isn't exported either).

- [ ] **Step 3: Replace `streamDeepSeek` (lines 60-126) with the refactored implementation**

In `worker/src/index.js`, replace the entire existing `streamDeepSeek` function with:

```js
function sseFormat(token) {
  return `data: ${JSON.stringify({ token })}\n\n`;
}

async function callDeepSeek(messages, apiKey, { tools } = {}) {
  const body = { model: 'deepseek-v4-flash', messages, stream: true };
  if (tools) body.tools = tools;

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  return response;
}

async function parseDeepSeekStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;
  const toolCallsByIndex = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        await onToken(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsByIndex.get(tc.index) || {
            id: '',
            function: { name: '', arguments: '' },
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name = tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  }

  return { finishReason, toolCalls: [...toolCallsByIndex.values()] };
}

async function streamDeepSeek(messages, apiKey, request) {
  const response = await callDeepSeek(messages, apiKey, {});

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      await parseDeepSeekStream(response, async (token) => {
        await writer.write(encoder.encode(sseFormat(token)));
      });
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (e) {
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\ndata: [DONE]\n\n`)
      );
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      ...getCorsHeaders(request),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

function replayBufferedAsSSE(tokens, request) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    for (const token of tokens) {
      await writer.write(encoder.encode(sseFormat(token)));
    }
    await writer.write(encoder.encode('data: [DONE]\n\n'));
    writer.close();
  })();

  return new Response(readable, {
    headers: {
      ...getCorsHeaders(request),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}
```

At the bottom of `worker/src/index.js`, after the existing `export default { ... }` block, add:

```js
export { callDeepSeek, parseDeepSeekStream, streamDeepSeek, replayBufferedAsSSE };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd worker && npx vitest run test/deepseekStream.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
cd worker && npm test
```

Expected: PASS (all existing `rateLimiter.test.js` and `deepDiveContext.test.js` tests still pass — they don't touch this code path, but this confirms nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.js worker/test/deepseekStream.test.js
git commit -m "refactor: extract callDeepSeek/parseDeepSeekStream helpers from streamDeepSeek"
```

---

### Task 4: Wire tool-calling into chat — `runChatCompletion`

**Files:**
- Modify: `worker/src/index.js`
- Create: `worker/test/runChatCompletion.test.js`

**Interfaces:**
- Consumes: `BGG_TOOL_DEFINITIONS`, `executeBggTool` from `worker/src/bggTools.js` (Tasks 1-2). `callDeepSeek`, `parseDeepSeekStream`, `streamDeepSeek`, `replayBufferedAsSSE` from Task 3 (same file).
- Produces: `runChatCompletion(messages, env, request)` — async, returns an SSE `Response` identical in shape to what `streamDeepSeek` produces today. Never throws (all errors become an SSE error frame via `sseError`).
- `handleChat`'s final call changes from `streamDeepSeek(messages, env.DEEPSEEK_API_KEY, request)` to `runChatCompletion(messages, env, request)`.

- [ ] **Step 1: Write the failing tests**

```js
// worker/test/runChatCompletion.test.js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runChatCompletion } from '../src/index.js';
import { executeBggTool } from '../src/bggTools.js';
import { fakeSSEResponse } from './sseHelpers.js';

vi.mock('../src/bggTools.js', () => ({
  BGG_TOOL_DEFINITIONS: [{ type: 'function', function: { name: 'bgg_search_game' } }],
  executeBggTool: vi.fn(),
}));

async function readAllText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

function fakeRequest() {
  return new Request('https://example.com/api/chat', { headers: { Origin: 'https://bgg.cardila.com' } });
}

function toolCallSSE(toolCalls) {
  return fakeSSEResponse([
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
        },
      ],
    }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
}

const noToolCallSSE = () =>
  fakeSSEResponse([
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hola' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]);

const env = { DEEPSEEK_API_KEY: 'key123', BGG_TOKEN: 'bgg-token' };

describe('runChatCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    executeBggTool.mockReset();
  });

  it('replays buffered content when no tool call is requested', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(text).toContain('data: {"token":"Hola"}');
    expect(text).toContain('data: [DONE]');
    expect(executeBggTool).not.toHaveBeenCalled();
  });

  it('executes a requested tool call and streams the follow-up answer', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      );
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion(
      [{ role: 'user', content: '¿qué expansión compro?' }],
      env,
      fakeRequest()
    );
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(executeBggTool).toHaveBeenCalledWith('bgg_search_game', { query: 'Wingspan' }, 'bgg-token');
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');

    const round2Body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = round2Body.messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toBe(JSON.stringify({ result: [{ id: 1, name: 'Wingspan' }] }));
    expect(round2Body.tools).toBeUndefined();
  });

  it('executes at most 3 tool calls per round', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const fiveToolCalls = Array.from({ length: 5 }, (_, i) => ({
      id: `call_${i}`,
      name: 'bgg_search_game',
      arguments: '{"query":"x"}',
    }));
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE(fiveToolCalls))
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());

    expect(executeBggTool).toHaveBeenCalledTimes(3);
  });

  it('passes a tool execution error through as the tool message content without aborting', async () => {
    executeBggTool.mockResolvedValue({ error: 'BGG unavailable' });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    const round2Body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = round2Body.messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toBe(JSON.stringify({ error: 'BGG unavailable' }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('never attempts a third round even if the follow-up response also requests tool calls', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"x"}' }]))
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_2', name: 'bgg_search_game', arguments: '{"query":"y"}' }]));
    vi.stubGlobal('fetch', mockFetch);

    await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(executeBggTool).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd worker && npx vitest run test/runChatCompletion.test.js
```

Expected: FAIL — `runChatCompletion` is not exported yet.

- [ ] **Step 3: Import `bggTools.js` and add `MAX_TOOL_CALLS_PER_ROUND` near the top of `index.js`**

At the top of `worker/src/index.js`, alongside the existing imports:

```js
import { buildDeepDiveContext } from './deepDiveContext.js';
import { checkRateLimit } from './rateLimiter.js';
import { BGG_TOOL_DEFINITIONS, executeBggTool } from './bggTools.js';

const MAX_TOOL_CALLS_PER_ROUND = 3;
```

- [ ] **Step 4: Add `runChatCompletion`, right after `replayBufferedAsSSE`**

```js
async function runChatCompletion(messages, env, request) {
  let firstResult;
  const bufferedTokens = [];

  try {
    const response = await callDeepSeek(messages, env.DEEPSEEK_API_KEY, {
      tools: BGG_TOOL_DEFINITIONS,
    });
    firstResult = await parseDeepSeekStream(response, async (token) => {
      bufferedTokens.push(token);
    });
  } catch (e) {
    return sseError(request, e.message);
  }

  if (firstResult.finishReason !== 'tool_calls' || firstResult.toolCalls.length === 0) {
    return replayBufferedAsSSE(bufferedTokens, request);
  }

  const toolCalls = firstResult.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);

  const toolMessages = await Promise.all(
    toolCalls.map(async (tc) => {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        // malformed arguments from the model; execute with no args, let the tool report the error
      }
      const { result, error } = await executeBggTool(tc.function.name, args, env.BGG_TOKEN);
      return {
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(error ? { error } : result),
      };
    })
  );

  const followUp = [
    ...messages,
    {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: tc.function,
      })),
    },
    ...toolMessages,
  ];

  try {
    return await streamDeepSeek(followUp, env.DEEPSEEK_API_KEY, request);
  } catch (e) {
    return sseError(request, e.message);
  }
}
```

- [ ] **Step 5: Wire `runChatCompletion` into `handleChat` and export it**

In `handleChat`, replace:

```js
  try {
    return await streamDeepSeek(messages, env.DEEPSEEK_API_KEY, request);
  } catch (e) {
    return sseError(request, e.message);
  }
```

with:

```js
  return runChatCompletion(messages, env, request);
```

Update the named export at the bottom of the file to include `runChatCompletion`:

```js
export { callDeepSeek, parseDeepSeekStream, streamDeepSeek, replayBufferedAsSSE, runChatCompletion };
```

- [ ] **Step 6: Add the BGG-awareness line to the 4 system prompts**

In `SYSTEM_PROMPTS.discovery.es`, right before the `IMPORTANTE:` line, add:

```
Si la pregunta requiere información que no está en el catálogo (por ejemplo, decidir qué expansión o juego nuevo comprar), tenés herramientas para buscar en BoardGameGeek en vivo — úsalas.
```

In `SYSTEM_PROMPTS.discovery.en`, right before the `IMPORTANT:` line, add:

```
If the question needs information not in the catalog (for example, deciding which expansion or new game to buy), you have tools to search BoardGameGeek live — use them.
```

In `SYSTEM_PROMPTS.deep_dive.es`, right before the `IMPORTANTE:` line, add:

```
Si la pregunta es sobre reglas discutidas en el foro de BGG, variantes hechas por fans, o modos de un jugador no oficiales que no están en el wiki, tenés herramientas para buscar en los foros de BoardGameGeek en vivo — úsalas.
```

In `SYSTEM_PROMPTS.deep_dive.en`, right before the `IMPORTANT:` line, add:

```
If the question is about rules discussed on BGG's forums, fan-made variants, or unofficial solo modes not in the wiki, you have tools to search BoardGameGeek's forums live — use them.
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd worker && npx vitest run test/runChatCompletion.test.js
```

Expected: PASS.

- [ ] **Step 8: Run the full test suite**

```bash
cd worker && npm test
```

Expected: PASS — all of `rateLimiter.test.js`, `deepDiveContext.test.js`, `bggTools.test.js`, `deepseekStream.test.js`, `runChatCompletion.test.js`.

- [ ] **Step 9: Commit**

```bash
git add worker/src/index.js worker/test/runChatCompletion.test.js
git commit -m "feat: wire BGG tool-calling into chat completions"
```

---

### Task 5: `BGG_TOKEN` secret and manual verification

**Files:** none (configuration + manual testing only)

**Interfaces:** none — this task validates Tasks 1-4 against the real BGG and DeepSeek APIs.

- [ ] **Step 1: Set the `BGG_TOKEN` Wrangler secret**

```bash
cd worker
wrangler secret put BGG_TOKEN
```

When prompted, paste the same token value currently stored as `GAMECACHE_BGG_TOKEN` (confirm current value via `scripts/setup_bgg_token.py` output or your `.env`, per `project_bgg_token_generator_broken` — the token generator is broken but this existing token is still valid).

- [ ] **Step 2: Start the worker locally**

```bash
cd worker
npm run dev
```

Leave this running.

- [ ] **Step 3: Verify the tool-calling path with a live request**

In a separate terminal:

```bash
curl -N -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"message":"buscá en BGG qué expansiones tiene Wingspan","mode":"discovery","language":"es"}'
```

Expected: after a brief pause (the buffered round-1 call + BGG lookup), the response streams `data: {"token":"..."}` frames whose content correctly names real Wingspan expansions, ending in `data: [DONE]`.

- [ ] **Step 4: Verify the non-tool path is unaffected**

```bash
curl -N -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"message":"hola, ¿cómo estás?","mode":"discovery","language":"es"}'
```

Expected: normal streamed greeting with no noticeable extra delay, since no tool call is triggered.

- [ ] **Step 5: Verify a forum-lookup question in `deep_dive` mode**

Use a `game` slug that exists in your KV (check via `curl http://localhost:8787/api/games`), then:

```bash
curl -N -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"message":"¿hay algún modo solitario no oficial para este juego según el foro de BGG?","mode":"deep_dive","game":"<slug-real>","language":"es"}'
```

Expected: the model calls `bgg_search_forum` (and possibly `bgg_get_thread`), and the final answer references actual forum content rather than only general knowledge.

- [ ] **Step 6: Deploy**

```bash
cd worker
npm run deploy
```

Confirm the Cloudflare dashboard shows a successful deployment of `mybgg-chat` with the new `BGG_TOKEN` secret present.

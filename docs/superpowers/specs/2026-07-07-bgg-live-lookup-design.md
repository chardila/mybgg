# BGG Live Lookup (MCP-lite tool-calling) — Design

**Date:** 2026-07-07
**Scope:** Give the DeepSeek-powered chat (`worker/src/index.js`) the ability to call live BoardGameGeek data — game search/details and forum/thread content — when a question falls outside the ingested wiki/catalog. Implemented as internal Worker tool-calling functions consumed only by this repo's own chat backend, not as a standalone MCP protocol server.

---

## Problem

The chat (`discovery` and `deep_dive` modes in `worker/src/index.js`) only ever sees two sources of truth: the pre-ingested game catalog (KV `catalog`) and the pre-ingested per-game wiki (KV `games/<slug>/*`). Anything not covered by that offline content — "what additional game should I buy given my collection", "what does the BGG forum say about this rule", "are there unofficial fan variants or solo modes for this game" — the model can only answer from its own training knowledge, with no way to check current BGG data.

Building a full spec-compliant MCP server (HTTP/SSE transport, JSON-RPC, session handling) was considered and rejected: the only consumer is this repo's own worker, which already talks to DeepSeek's OpenAI-compatible chat completions API — an API that supports native `tools` function-calling. A full MCP server would add protocol machinery (transport, discovery, auth for third-party clients) that nothing here would use.

`kkjdaniel/bgg-mcp` was used as a reference for *which* capabilities are useful (search, details, forum/thread access) but not for implementation — it's a Go binary using stdio transport, which doesn't run in the Workers runtime and isn't reusable here.

---

## Solution

Add BGG as a set of **function-calling tools** on the existing DeepSeek chat completion calls, backed by BGG's official `xmlapi2`. The model decides when a question needs live BGG data and formulates the query; the worker executes the lookup and feeds the result back for a final answer — standard OpenAI-style tool-calling, single round.

**Tools exposed (both `discovery` and `deep_dive` modes):**

| Tool | Purpose | BGG endpoint |
|---|---|---|
| `bgg_search_game` | Search games by name | `xmlapi2/search` |
| `bgg_get_game_details` | Rating, mechanics, year, expansions for a specific game | `xmlapi2/thing` |
| `bgg_search_forum` | Find forum threads on a game matching a term (rules, fan variants, solo modes) | `xmlapi2/forumlist` + `xmlapi2/forum` |
| `bgg_get_thread` | Full post content of a specific thread | `xmlapi2/thread` |

**Auth:** reuse the same bearer-token scheme already proven in `scripts/gamecache/bgg_client.py` (`Authorization: Bearer <token>` against `xmlapi2`). The worker gets its own Wrangler secret, `BGG_TOKEN`, set once via `wrangler secret put BGG_TOKEN` (same token value as the existing `GAMECACHE_BGG_TOKEN`, but a separate secret since the Python scripts and the Worker don't share an environment).

---

## Files Changed

```
worker/
├── package.json          ← add fast-xml-parser dependency
├── src/
│   ├── bggTools.js        ← new: tool schemas + xmlapi2 client + XML→JSON parsing
│   └── index.js           ← wire tools into handleChat(); extract runChatCompletion()
└── test/
    ├── bggTools.test.js          ← new
    └── runChatCompletion.test.js ← new
```

`chat.html` is unchanged — it consumes the same SSE token stream regardless of whether a tool call happened server-side.

---

## Module: `worker/src/bggTools.js` (new)

```js
export const BGG_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'bgg_search_game',
      description: 'Search BoardGameGeek for games by name.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          type: { type: 'string', enum: ['boardgame', 'boardgameexpansion', 'all'] },
        },
        required: ['query'],
      },
    },
  },
  // bgg_get_game_details(bgg_id), bgg_search_forum(bgg_id, query), bgg_get_thread(thread_id)
  // follow the same shape.
];

export async function executeBggTool(name, args, token) {
  try {
    switch (name) {
      case 'bgg_search_game': return { result: await searchGame(args, token) };
      case 'bgg_get_game_details': return { result: await getGameDetails(args, token) };
      case 'bgg_search_forum': return { result: await searchForum(args, token) };
      case 'bgg_get_thread': return { result: await getThread(args, token) };
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}
```

- Uses `fast-xml-parser` to parse `xmlapi2` XML responses into plain objects, then each `search`/`getGameDetails`/`searchForum`/`getThread` function trims that down to the compact fields the model actually needs (id, name, year, rating, mechanics, expansions for games; thread id/title/author/date/text for forum content).
- `searchForum` calls `forumlist` to find the right forum id for the game, then `forum` to list threads, and filters client-side by whether the term appears in the thread title (BGG's forum API has no full-text search).
- Every function throws on HTTP-level failure (network error, non-2xx, 401) — caught once in `executeBggTool` and turned into `{error: message}`, never a thrown exception past this module.

---

## Module Changes: `worker/src/index.js`

**`SYSTEM_PROMPTS`:** both `discovery` and `deep_dive` prompts (es/en) gain one line noting that BGG lookup tools are available for questions the catalog/wiki doesn't cover.

**New extracted function `runChatCompletion(messages, env, request)`**, replacing the direct `streamDeepSeek(...)` call in `handleChat`:

```js
async function runChatCompletion(messages, env, request) {
  // Round 1: streamed, but buffered — not forwarded to the client yet.
  const first = await callDeepSeekBuffered(messages, env.DEEPSEEK_API_KEY, {
    tools: BGG_TOOL_DEFINITIONS,
  });

  if (first.finishReason !== 'tool_calls') {
    return replayBufferedAsSSE(first.buffer, request);
  }

  const toolCalls = first.toolCalls.slice(0, 3); // cap: max 3 tool calls per round
  const toolMessages = await Promise.all(
    toolCalls.map(async (tc) => {
      const args = JSON.parse(tc.function.arguments);
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
    { role: 'assistant', tool_calls: toolCalls },
    ...toolMessages,
  ];

  // Round 2: streamed live to the client. No `tools` param — no further rounds.
  return streamDeepSeek(followUp, env.DEEPSEEK_API_KEY, request);
}
```

- `callDeepSeekBuffered`: refactor of the existing streaming-parse loop in `streamDeepSeek`, but instead of writing each token to the client's `TransformStream`, it accumulates `content` deltas and reassembles chunked `tool_calls` fragments (id/name arrive once, `arguments` arrive incrementally and are concatenated), returning `{ buffer, toolCalls, finishReason }` once the stream ends.
- `replayBufferedAsSSE`: wraps the already-known full buffer in the same `TransformStream`/SSE response shape `streamDeepSeek` produces today, so the client-visible contract doesn't change.
- `streamDeepSeek` itself is unchanged — round 2 reuses it exactly as before, just with a longer `messages` array.
- Only one round of tool calls is ever made: round 2 is called without a `tools` param, so DeepSeek cannot request further tool calls.

**`handleChat`:** replaces its final `return await streamDeepSeek(messages, env.DEEPSEEK_API_KEY, request)` with `return await runChatCompletion(messages, env, request)`. No other changes to `handleChat`'s existing branch logic (discovery/deep_dive context building, rate limiting, validation) — tools are simply available in both branches since they're attached in `runChatCompletion`, not per-mode.

---

## Error Handling & Limits

- **BGG API failures** (network error, 5xx, 401): caught inside `executeBggTool`, returned as `{error: "..."}` and fed back to the model as the `tool` message content — the model incorporates this into its answer ("no pude consultar BGG ahora mismo") rather than the request failing outright. A 401 specifically logs via `console.error` server-side (token may have expired, same failure mode already seen with `GAMECACHE_BGG_TOKEN`).
- **Tool call cap:** max 3 tool calls executed per round (`toolCalls.slice(0, 3)`); if the model requested more, the rest are simply not executed — no error surfaced, since 3 is expected to comfortably cover real usage (e.g. comparing 2-3 games).
- **Round cap:** exactly one tool-calling round per chat turn — round 2 omits the `tools` param entirely, so a second round is structurally impossible, not just discouraged.
- **Rate limiting:** the existing per-IP limiter (`checkRateLimit`, 20 req/min on `/api/chat`) is unchanged and covers this — no separate limit for BGG-triggered requests, since this is single-user, low-volume usage.
- **No caching, no retries:** each tool call hits `xmlapi2` live; a failure is not retried. Not justified at this volume.

---

## Testing

### `worker/test/bggTools.test.js` (vitest, mocked `fetch`)

- Each of the 4 tools: mock a representative `xmlapi2` XML response, assert the parsed/trimmed JSON shape.
- `bgg_search_forum`: mock `forumlist` + `forum` responses, verify thread filtering by search term.
- Error cases: `fetch` rejects, BGG returns 401, BGG returns 5xx → assert `{error}` is returned, not a thrown exception.
- Assert the `Authorization: Bearer <token>` header is sent on every call.

### `worker/test/runChatCompletion.test.js` (vitest, mocked DeepSeek responses)

- No tool call (`finish_reason: "stop"`): output SSE stream matches today's `streamDeepSeek` behavior exactly (regression check).
- Tool call path: mock round-1 response with `tool_calls`, assert `executeBggTool` is called with correctly-parsed arguments, assert round-2 request includes the `assistant`/`tool` messages, assert round-2's stream is what gets forwarded to the client.
- Cap enforcement: round-1 requests 5 tool calls → only first 3 executed. Round-2 response itself contains `tool_calls` → ignored, round-2 content is returned as final regardless.
- A tool execution error is passed through as `tool` message content without aborting the flow.

No integration tests against the real BGG API (avoids network/credential dependence in CI), consistent with the rest of `worker/test/`.

---

## Out of Scope

- A spec-compliant MCP server (HTTP/SSE transport, JSON-RPC, OAuth) — rejected; see Problem section.
- `bgg_hot` (hotness list) and algorithmic recommendations (Recommend.Games) — not needed for the stated use cases (buy decisions, rules/forum questions); can be added later as additional tools following the same pattern.
- `bgg-price` / `bgg-trade-finder` (BoardGamePrices.co.uk, cross-user trading) — out of scope, third-party dependencies not needed for personal use.
- A `bgg_get_my_collection` tool — the user's collection already lives locally (SQLite/catalog KV), no need to re-fetch it from BGG live.
- Caching of BGG API responses (e.g. in KV) — not justified at current volume; revisit if usage grows.
- Multi-round tool-calling (tool call → tool call → tool call chains) — capped at one round by design.
- Any change to the rate limiter or a BGG-specific rate limit.

# Chat Rate Limiting — Design

**Date:** 2026-07-05
**Scope:** Add per-IP rate limiting to `POST /api/chat` in the Cloudflare Worker, using the existing `WIKI` KV namespace. No other endpoints or files are affected.

---

## Problem

`/api/chat` is public and unauthenticated. It has no cost or abuse protection: anyone can call it directly (bypassing `chat.html` and its CORS-enforced origin) and burn through the DeepSeek API quota billed to `env.DEEPSEEK_API_KEY`, by sending arbitrary messages in a loop. The only existing guardrail is a system-prompt instruction telling the model to stay on topic — that's advisory to the LLM, not an access control, and is trivially bypassed with prompt injection.

---

## Solution

Cap requests per IP to `/api/chat` using a fixed-window counter stored in the existing `WIKI` KV namespace (no new KV namespace or wrangler binding needed).

**Limit:** 20 requests per 60-second window, per IP.

**Algorithm — fixed window:**
- Key: `ratelimit:chat:<ip>:<windowStart>`, where `windowStart = Math.floor(now / 60000)` (current minute, as an integer).
- On each request: read the counter. If `count >= 20`, reject. Otherwise increment and write back with `expirationTtl` of 120 seconds (2x the window), so stale keys self-expire without any cleanup job.
- This is a fixed window, not sliding: a client could in theory send up to ~2x the nominal limit across a minute boundary (e.g. 20 requests at `:59` and 20 more at `:01`). Accepted trade-off — the goal is blunting abuse/cost, not precise accounting.
- KV is eventually consistent across Cloudflare's edge (reads in one colo may not immediately reflect writes from another). A distributed attacker hitting many colos could exceed the nominal limit somewhat. Accepted trade-off for a "simple" rate limiter — this is not a hard security boundary, it's a cost/abuse deterrent.

**IP extraction:** `request.headers.get('CF-Connecting-IP')`. This header is set by Cloudflare's edge and cannot be spoofed by the client. If absent (e.g. running locally via `wrangler dev`, where the header may not be present), fall back to the fixed bucket key `'unknown'` — a known limitation of local dev (all local requests share one bucket), with no effect on production.

---

## Files Changed

Only the `worker/` directory is touched. `chat.html` requires no changes.

```
worker/
├── src/
│   ├── rateLimiter.js   ← new: pure, testable rate-limit check
│   └── index.js         ← wire checkRateLimit() into handleChat(); sseError() gains optional status param
└── test/
    └── rateLimiter.test.js  ← new: unit tests with an in-memory fake store
```

---

## Module Changes

### `worker/src/rateLimiter.js` (new)

Pure function, no Cloudflare-specific types, so it can be unit tested without mocking `env` or `Request`.

```js
const DEFAULT_LIMIT = 20;
const DEFAULT_WINDOW_SECONDS = 60;

export async function checkRateLimit({
  store,
  ip,
  now = Date.now(),
  limit = DEFAULT_LIMIT,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
}) {
  const windowStart = Math.floor(now / (windowSeconds * 1000));
  const key = `ratelimit:chat:${ip}:${windowStart}`;

  const current = await store.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= limit) {
    return { allowed: false };
  }

  await store.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
  return { allowed: true };
}
```

`store` is any object with `.get(key)` returning a string or null, and `.put(key, value, { expirationTtl })`. In production this is `env.WIKI`; in tests it's an in-memory `Map`-backed stub.

### `worker/src/index.js`

**`getCorsHeaders`, `SYSTEM_PROMPTS`, `streamDeepSeek`, `handleGetGames`, `handleDebugContext`:** unchanged.

**`sseError`:** gains an optional `status` parameter, defaulting to 200 (preserves current behavior for all existing call sites):

```js
function sseError(request, message, status = 200) {
  return new Response(
    `data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`,
    { status, headers: { ...getCorsHeaders(request), 'Content-Type': 'text/event-stream' } }
  );
}
```

**`handleChat`:** import `checkRateLimit` from `./rateLimiter.js`. Immediately after successfully parsing the JSON body (so we have `language` for the localized message, but before any KV wiki lookups or the DeepSeek call):

```js
const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
const { allowed } = await checkRateLimit({ store: env.WIKI, ip });
if (!allowed) {
  const msg = language === 'en'
    ? 'Too many requests. Please wait a minute and try again.'
    : 'Demasiadas solicitudes. Espera un minuto e intenta de nuevo.';
  return sseError(request, msg, 429);
}
```

No changes to `discovery` / `deep_dive` branch logic below this point.

---

## `chat.html`

No changes required. It already reads only the `parsed.error` field from the SSE stream (`chat.html:378-382`) and never inspects `res.status` — a 429 with an SSE-formatted error body renders identically to any other chat error today.

---

## Testing

### Unit tests (`worker/test/rateLimiter.test.js`, vitest, same pattern as `deepDiveContext.test.js`)

Use a fake in-memory store:
```js
function createFakeStore() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
  };
}
```

Cases:
- Allows requests while under the limit (e.g. 1st through 20th request with `limit: 20` all return `allowed: true`).
- Blocks the request that would exceed the limit (21st request returns `allowed: false`).
- Resets after the window elapses (inject `now` past the window boundary; the next request is allowed again).
- Different IPs are tracked independently (one IP hitting its limit doesn't affect another).

### Manual / integration verification

Run the worker locally with `wrangler dev` and drive it with real HTTP requests (e.g. a small loop of `curl -X POST .../api/chat`) to confirm:
- The 21st rapid request in a window returns HTTP 429 with a valid SSE body containing the expected error message.
- `chat.html`, loaded against the local worker, still completes a normal conversation under the limit, and shows a visible error message (not a broken UI) once the limit is hit.

---

## Out of Scope

- Rate limiting `/api/games` or `/api/debug/context` (no external API cost; not addressed here).
- A separate KV namespace for rate-limit data (reusing `WIKI` per the simplicity goal of this change).
- Sliding-window or token-bucket algorithms (fixed window is accepted as "good enough" for an abuse deterrent).
- Any authentication/API-key scheme for `/api/chat` (a further hardening option, not requested here).
- Cross-colo strong consistency guarantees for the counter (accepted KV eventual-consistency trade-off).

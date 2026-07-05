# Chat Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-IP rate limiting (20 requests/minute) to `POST /api/chat` in the Cloudflare Worker, so the endpoint can't be used as an unlimited free proxy to the DeepSeek API billed to `env.DEEPSEEK_API_KEY`.

**Architecture:** A new pure module `worker/src/rateLimiter.js` implements a fixed-window counter with an injectable KV-like store, testable without any Cloudflare runtime. `worker/src/index.js` wires it into `handleChat`, using the existing `WIKI` KV namespace as the store and `CF-Connecting-IP` as the client identity. On rejection, reuse the existing SSE error format (extended with an optional HTTP status) so `chat.html` needs no changes.

**Tech Stack:** Cloudflare Workers (JS modules), Vitest for unit tests, Wrangler for local dev.

## Global Constraints

- Reuse the existing `WIKI` KV namespace (`worker/wrangler.toml`) — do not add a new KV namespace or binding.
- Default limit: 20 requests per 60-second window, per IP (fixed window, not sliding).
- Client IP comes from the `CF-Connecting-IP` request header; fall back to the literal string `'unknown'` if absent (local dev only).
- `chat.html` must not require any changes — it already only reads `parsed.error` from the SSE stream, never `response.status`.
- All existing `sseError(...)` call sites in `worker/src/index.js` must keep returning HTTP 200 (only the new rate-limit call site uses 429).

---

## Task 1: `rateLimiter.js` module with unit tests

**Files:**
- Create: `worker/src/rateLimiter.js`
- Create: `worker/test/rateLimiter.test.js`

**Interfaces:**
- Produces: `checkRateLimit({ store, ip, now, limit, windowSeconds }) => Promise<{ allowed: boolean }>`, exported from `worker/src/rateLimiter.js`. `store` is any object exposing `async get(key) => string | null` and `async put(key, value, { expirationTtl }) => void`. `now`, `limit`, `windowSeconds` are optional (default to `Date.now()`, `20`, `60` respectively).

- [ ] **Step 1: Write the failing test file**

Create `worker/test/rateLimiter.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '../src/rateLimiter.js';

function createFakeStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    _map: map,
  };
}

describe('checkRateLimit', () => {
  it('allows requests while under the limit', async () => {
    const store = createFakeStore();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      const result = await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks the request that would exceed the limit', async () => {
    const store = createFakeStore();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    }
    const result = await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    expect(result.allowed).toBe(false);
  });

  it('resets after the window elapses', async () => {
    const store = createFakeStore();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    }
    const blocked = await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    expect(blocked.allowed).toBe(false);

    const later = now + 61 * 1000;
    const result = await checkRateLimit({ store, ip: '1.2.3.4', now: later, limit: 20, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
  });

  it('tracks different IPs independently', async () => {
    const store = createFakeStore();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    }
    const blockedFirstIp = await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    expect(blockedFirstIp.allowed).toBe(false);

    const otherIp = await checkRateLimit({ store, ip: '5.6.7.8', now, limit: 20, windowSeconds: 60 });
    expect(otherIp.allowed).toBe(true);
  });

  it('passes expirationTtl of 2x the window to the store', async () => {
    const store = createFakeStore();
    let capturedOpts;
    const spyStore = {
      async get(key) { return store.get(key); },
      async put(key, value, opts) {
        capturedOpts = opts;
        return store.put(key, value, opts);
      },
    };
    await checkRateLimit({ store: spyStore, ip: '1.2.3.4', now: Date.now(), limit: 20, windowSeconds: 60 });
    expect(capturedOpts).toEqual({ expirationTtl: 120 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd worker && npx vitest run test/rateLimiter.test.js`
Expected: FAIL — `Cannot find module '../src/rateLimiter.js'` (or similar resolution error), since the module doesn't exist yet.

- [ ] **Step 3: Implement `rateLimiter.js`**

Create `worker/src/rateLimiter.js`:

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd worker && npx vitest run test/rateLimiter.test.js`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Run the full worker test suite to check for regressions**

Run: `cd worker && npm test`
Expected: PASS — this includes the existing `deepDiveContext.test.js` suite plus the new `rateLimiter.test.js`, all green.

- [ ] **Step 6: Commit**

```bash
git add worker/src/rateLimiter.js worker/test/rateLimiter.test.js
git commit -m "feat: add per-IP fixed-window rate limiter module

Pure, testable module with an injectable KV-like store. Not yet wired
into any handler."
```

---

## Task 2: Wire rate limiting into `handleChat`

**Files:**
- Modify: `worker/src/index.js:1` (import)
- Modify: `worker/src/index.js:52-57` (`sseError`)
- Modify: `worker/src/index.js:176-186` (`handleChat`, after body destructuring)

**Interfaces:**
- Consumes: `checkRateLimit({ store, ip, now, limit, windowSeconds }) => Promise<{ allowed: boolean }>` from Task 1's `worker/src/rateLimiter.js`.

- [ ] **Step 1: Add the import**

In `worker/src/index.js`, change line 1 from:

```js
import { buildDeepDiveContext } from './deepDiveContext.js';
```

to:

```js
import { buildDeepDiveContext } from './deepDiveContext.js';
import { checkRateLimit } from './rateLimiter.js';
```

- [ ] **Step 2: Add an optional `status` parameter to `sseError`**

In `worker/src/index.js`, change:

```js
function sseError(request, message) {
  return new Response(
    `data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`,
    { headers: { ...getCorsHeaders(request), 'Content-Type': 'text/event-stream' } }
  );
}
```

to:

```js
function sseError(request, message, status = 200) {
  return new Response(
    `data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`,
    { status, headers: { ...getCorsHeaders(request), 'Content-Type': 'text/event-stream' } }
  );
}
```

Every existing call site (`sseError(request, 'Invalid JSON body')`, etc.) omits the third argument, so they keep returning HTTP 200 — unchanged behavior.

- [ ] **Step 3: Add the rate-limit check in `handleChat`**

In `worker/src/index.js`, find:

```js
  const { message, history = [], mode = 'discovery', game = null, expansions = [], language = 'es' } = body;

  if (!message) return sseError(request, 'message is required');

  let systemContent;
```

Replace with:

```js
  const { message, history = [], mode = 'discovery', game = null, expansions = [], language = 'es' } = body;

  if (!message) return sseError(request, 'message is required');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { allowed } = await checkRateLimit({ store: env.WIKI, ip });
  if (!allowed) {
    const rateLimitMessage = language === 'en'
      ? 'Too many requests. Please wait a minute and try again.'
      : 'Demasiadas solicitudes. Espera un minuto e intenta de nuevo.';
    return sseError(request, rateLimitMessage, 429);
  }

  let systemContent;
```

- [ ] **Step 4: Run the full worker test suite**

Run: `cd worker && npm test`
Expected: PASS — no existing test exercises `handleChat` directly, so this step confirms nothing else broke (module resolution, syntax, existing `deepDiveContext` and `rateLimiter` suites).

- [ ] **Step 5: Manually verify the 429 behavior with `wrangler dev`**

Start the worker locally (uses local, non-production KV automatically since `--remote` is not passed):

Run: `cd worker && npx wrangler dev`
Expected: Output includes `Ready on http://localhost:8787` (port may vary — use whatever Wrangler prints).

In a second terminal, send 21 rapid requests to `/api/chat` and inspect the last one:

```bash
for i in $(seq 1 21); do
  echo "--- request $i ---"
  curl -s -o /tmp/rl-out.txt -w "HTTP %{http_code}\n" \
    -X POST http://localhost:8787/api/chat \
    -H 'Content-Type: application/json' \
    -d '{"message":"hola","mode":"discovery","language":"es"}'
done
tail -c 300 /tmp/rl-out.txt
```

Expected:
- Requests 1–20 report `HTTP 200` (each a real SSE stream — content depends on whether `DEEPSEEK_API_KEY` in `worker/.dev.vars` is valid, but the status must be 200 either way since the rate limiter allowed them).
- Request 21 reports `HTTP 429`, and `/tmp/rl-out.txt` contains `data: {"error":"Demasiadas solicitudes. Espera un minuto e intenta de nuevo."}` followed by `data: [DONE]`.

- [ ] **Step 6: Manually verify `chat.html` still works end-to-end under the limit**

With `wrangler dev` still running, open `chat.html` in a browser pointed at the local worker (check the `WORKER_URL` constant near the top of `chat.html` — temporarily point it at `http://localhost:8787` if it isn't already, being careful not to commit that change), send 2–3 normal messages, and confirm:
- Responses stream in normally, no visible regression.
- No error message appears (since 2–3 messages is well under the 20/minute limit).

Revert any temporary `WORKER_URL` change in `chat.html` before committing (`git diff chat.html` should be empty).

- [ ] **Step 7: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: rate-limit /api/chat to 20 requests/minute per IP

Prevents unauthenticated abuse of the endpoint as a free proxy to the
DeepSeek API. Uses the existing WIKI KV namespace as the counter store;
chat.html requires no changes since it only reads the SSE error field,
not the HTTP status."
```

---

## Out of Scope (unchanged from the design spec)

- Rate limiting `/api/games` or `/api/debug/context`.
- A separate KV namespace for rate-limit data.
- Sliding-window or token-bucket algorithms.
- Authentication/API-key scheme for `/api/chat`.
- Strong cross-colo consistency guarantees for the counter.

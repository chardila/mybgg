# Chat Progress Indicator — Design

**Date:** 2026-07-08
**Scope:** Stream phase-status events from the chat backend and show them in `chat.html` while the user waits, plus a stall reassurance after 8s of silence within a phase. Backend: `worker/src/index.js`. Frontend: `chat.html`.

---

## Problem

`runChatCompletion` buffers each round's entire response server-side (needed for the DSML-leak and incomplete-stream retry logic) before ever returning an HTTP `Response` to the caller. Concretely, the function does not call `replayBufferedAsSSE` / return a `Response` until every round has fully completed — so the browser's `fetch()` receives zero bytes, and `chat.html` shows a static blinking cursor, for the entire 6–12s (observed) that the multi-round Gemini/DeepSeek pipeline takes. The user has no way to tell whether the request is progressing or hung.

---

## Solution

### Backend: open the SSE stream immediately, emit status frames as rounds progress

Restructure `runChatCompletion` so the `Response` (backed by a `TransformStream`) is created and returned **immediately**, and all round-processing — Gemini tool-calling loop, tool execution, DeepSeek synthesis, retries, error handling — runs inside a single detached async function that writes into the already-open stream. This is the same "open stream now, write into it from a background async IIFE" pattern already used by `streamDeepSeek` and `replayBufferedAsSSE` today; it's extended to wrap the whole request instead of only the final reply.

A new SSE frame type, `status`, is interleaved with the existing `token` and `error` frames:

```
data: {"status": "searching"}
```

Status codes, emitted at each phase transition:

| Code | Emitted when |
|---|---|
| `thinking` | Before round 1's Gemini call, and again before the round-2 Gemini call that checks whether more tools are needed |
| `searching` | About to execute a round whose tool calls are all `bgg_search_game` (or a mixed set — this is also the generic fallback) |
| `details` | About to execute a round whose tool calls are all `bgg_get_game_details` |
| `forum` | About to execute a round whose tool calls are all `bgg_search_forum` / `bgg_get_thread` |
| `writing` | Before the final DeepSeek synthesis call |

The backend never emits human-readable text for these — `chat.html` owns the label/emoji per `currentLanguage`, matching how `openingEs`/`openingEn` already work.

Content itself (the actual answer, or the graceful DSML-fallback message) is still fully buffered and validated before being written as `token` frames — no change to the existing retry/fallback safety guarantees. Only the *status* frames are live; the *content* remains buffer-then-reveal.

### Error handling

All the existing `try { ... } catch (e) { return sseError(request, e.message) }` blocks inside `runChatCompletion` are consolidated into one `try/catch` around the whole background function. On an unrecoverable error, it writes an `error` frame into the already-open stream and closes it — it can no longer return a fresh `Response`, since one was already returned to the runtime. `sseError`'s pre-flight callers in `handleChat` (invalid JSON, missing message, rate limit, invalid mode/game/expansion) are untouched — those happen before `runChatCompletion` is ever called.

The friendly DSML-fallback message continues to travel as a normal `token` frame (not `error`) — from the client's perspective it's just the final answer, same as today.

### Frontend: phase label + stall reassurance

`addStreamingMessage()` starts the bubble with an optimistic `thinking` label instead of a bare cursor, covering the gap between clicking send and the first SSE byte arriving. Each `status` frame replaces that label (mapped through a small bilingual table). The first `token` frame clears the label and switches to normal text streaming, exactly as today.

```js
const STATUS_LABELS = {
  es: {
    thinking:  '💭 Pensando...',
    searching: '🔍 Buscando en BoardGameGeek...',
    details:   '📖 Consultando detalles del juego...',
    forum:     '💬 Revisando foros de BoardGameGeek...',
    writing:   '✍️ Escribiendo respuesta...',
  },
  en: {
    thinking:  '💭 Thinking...',
    searching: '🔍 Searching BoardGameGeek...',
    details:   '📖 Looking up game details...',
    forum:     '💬 Checking BoardGameGeek forums...',
    writing:   '✍️ Writing the answer...',
  },
};
```

A `lastEventTime` timestamp resets on every `status` or `token` frame. A `setInterval` (1s tick) compares `Date.now() - lastEventTime`; once it exceeds **8000ms** while still streaming and no `token` has arrived yet, a second line appears below the phase label with a live, growing counter:

- es: `Esto está tardando más de lo usual (Ns)...`
- en: `This is taking longer than usual (Ns)...`

The counter itself (ticking up every second) is the liveness signal — no extra polling or animation needed. The interval is cleared on `[DONE]`, an `error` frame, or the network-failure `catch` block (all three already exist as exit points in `sendMessage`).

---

## Files Changed

```
worker/
├── src/
│   └── index.js   ← runChatCompletion restructured to stream-first; status-frame helper; tool-name→status mapping
└── test/
    └── runChatCompletion.test.js  ← existing tests updated to drain via readAllText(); new status-ordering tests

chat.html          ← status label table, addStreamingMessage() default state, status-frame handling in the SSE
                       parse loop, stall-reassurance timer
```

No changes to `wrangler.toml`, `bggTools.js`, `rateLimiter.js`, or `deepDiveContext.js`.

---

## Module Changes

### `worker/src/index.js`

**New helpers**, near the existing `sseFormat`:

```js
function sseStatusFormat(status) {
  return `data: ${JSON.stringify({ status })}\n\n`;
}

function sseErrorFormat(message) {
  return `data: ${JSON.stringify({ error: message })}\n\n`;
}
```

**Tool-name → status code mapping**, used right before executing a round's tool calls:

```js
function statusForToolCalls(toolCalls) {
  const names = new Set(toolCalls.map((tc) => tc.function.name));
  if (names.size === 1) {
    const name = [...names][0];
    if (name === 'bgg_get_game_details') return 'details';
    if (name === 'bgg_search_forum' || name === 'bgg_get_thread') return 'forum';
  }
  return 'searching';
}
```

**`runChatCompletion`** restructured: the current body (the `for` loop over `MAX_TOOL_ROUNDS`, tool execution, and the final DeepSeek call) moves into an inner function, e.g. `runChatCompletionStream(messages, env, language, write)`, where `write(frame: string)` is a callback that writes a raw SSE frame into the open stream. Every early-return point (`replayBufferedAsSSE(...)`, `sseError` calls) becomes a call to `write(sseFormat(token))` for each buffered token, or `write(sseErrorFormat(message))` for errors, followed by `return` (ending the inner function, not producing a `Response`).

```js
async function runChatCompletion(messages, env, request, language = 'es') {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (frame) => writer.write(encoder.encode(frame));

  (async () => {
    try {
      await runChatCompletionStream(messages, env, language, write);
    } catch (e) {
      await write(sseErrorFormat(e.message));
    } finally {
      await write('data: [DONE]\n\n');
      await writer.close();
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
```

`runChatCompletionStream` keeps the exact same control flow that exists today (the `MAX_TOOL_ROUNDS` loop, `attemptBufferedRoundWithRetry`, `executeToolCalls`, `toolCallsAssistantMessage`, `noMoreToolsNote`, the DeepSeek synthesis call) — the only additions are `await write(sseStatusFormat('thinking'))` before each Gemini call in the loop, and `await write(sseStatusFormat(statusForToolCalls(toolCalls)))` right before `executeToolCalls`, and `await write(sseStatusFormat('writing'))` before the final DeepSeek call. Every place that currently does `return replayBufferedAsSSE(tokens, request)` becomes `for (const t of tokens) await write(sseFormat(t)); return;`. Every place that currently does `return sseError(request, e.message)` becomes `await write(sseErrorFormat(e.message)); return;`.

`sseError` remains unchanged and in use elsewhere (`handleChat`'s pre-flight validation, rate limiting) — it is not called from inside `runChatCompletionStream` anymore, only the raw `write`-based equivalent (`sseErrorFormat`) is. `replayBufferedAsSSE` lost all of its call sites during this refactor and was removed as dead code.

### `chat.html`

**New constant** `STATUS_LABELS` (shown above under Frontend).

**`addStreamingMessage()`** initializes with the `thinking` label instead of a bare cursor:

```js
function addStreamingMessage() {
  const container = document.getElementById('chat-container');
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `<span class="status-label">${STATUS_LABELS[currentLanguage].thinking}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}
```

**`sendMessage()`**: adds stall-timer state and a new branch in the parse loop for `parsed.status`:

```js
let lastEventTime = Date.now();
let stallShown = false;
const stallInterval = setInterval(() => {
  const elapsed = Math.floor((Date.now() - lastEventTime) / 1000);
  if (elapsed >= 8 && fullText === '') {
    const label = currentLanguage === 'en'
      ? `This is taking longer than usual (${elapsed}s)...`
      : `Esto está tardando más de lo usual (${elapsed}s)...`;
    let stallEl = streamDiv.querySelector('.stall-note');
    if (!stallEl) {
      stallEl = document.createElement('div');
      stallEl.className = 'stall-note';
      streamDiv.appendChild(stallEl);
    }
    stallEl.textContent = label;
    stallShown = true;
  }
}, 1000);
```

(`fullText === ''` guards against showing the stall note once real content has started rendering — at that point the phase label/stall note area no longer exists in the DOM, since `streamDiv.innerHTML` gets overwritten by `renderMarkdown(fullText)`.)

In the frame-parsing loop, alongside the existing `parsed.error` / `parsed.token` branches:

```js
if (parsed.status) {
  lastEventTime = Date.now();
  streamDiv.innerHTML = `<span class="status-label">${STATUS_LABELS[currentLanguage][parsed.status] || STATUS_LABELS[currentLanguage].thinking}</span>`;
}
```

The existing `parsed.token` branch also resets `lastEventTime = Date.now()`.

`clearInterval(stallInterval)` is added to: the `[DONE]` branch, the `parsed.error` branch, and the outer `catch (e)` block (network failure) — the three existing exit paths of `sendMessage`.

**CSS**: two small additions near `.cursor`:

```css
.status-label { color: #777; font-style: italic; }
.stall-note { color: #999; font-size: 13px; margin-top: 4px; font-style: italic; }
```

---

## Testing

### Unit tests (`worker/test/runChatCompletion.test.js`)

All existing tests that assert on `mockFetch` call counts or `executeBggTool` calls without first draining the response must add `await readAllText(response)` before those assertions — the `Response` now resolves as soon as the stream opens, not after processing finishes, so assertions racing the background writer must wait for `[DONE]` first (tests already doing `readAllText` are unaffected).

New cases:
- No tool call needed: stream contains exactly one `status: thinking` frame before the `token` frames (no `searching`/`writing`).
- Single tool round: `thinking` → `searching` (or `details`/`forum` per tool name) → `thinking` (round-2 confirmation) → `writing` → tokens.
- Capped at 2 rounds: two `searching`/`details` phases appear, no third, `writing` still appears (with the capping note in the request body, per existing test).
- A non-retryable failure produces an `error` frame followed by `[DONE]`, within the same stream (assert via `readAllText`, not via a distinct `Response`).

### Manual / integration verification

`wrangler dev` + `chat.html` pointed at the local worker (or `curl -N` inspecting raw SSE frames) to confirm:
- Phase labels appear and change in the right order for a real multi-tool-call question (e.g. the Ark Nova rating/complexity query).
- The stall note appears after ~8s on a slow round and shows a live-incrementing counter.
- Everything clears correctly and normal text rendering takes over once tokens start.
- A forced error (e.g. temporarily wrong API key) still surfaces as a visible error bubble, not a stuck "Pensando...".

---

## Out of Scope

- Cancel/abort button for the user to give up waiting (not requested — the stall note is reassurance only, not a control).
- Persisting or replaying status events in `history` (they're ephemeral UI state, never sent back to the API).
- Distinguishing retries (DSML leak / incomplete stream) with their own status code — retries surface naturally as "still on the same phase, stall timer keeps counting," which is accurate.
- A test framework for `chat.html` (none exists in this project; verification stays manual, consistent with prior frontend-touching changes).

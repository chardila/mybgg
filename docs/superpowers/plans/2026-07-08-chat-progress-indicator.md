# Chat Progress Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream phase-status SSE events (`thinking`/`searching`/`details`/`forum`/`writing`) from the chat backend while a request is in flight, and show them — plus a stall reassurance after 8s of silence — in `chat.html`, so the user knows the request is progressing during the 6–12s multi-round pipeline instead of staring at a static cursor.

**Architecture:** `runChatCompletion` currently buffers the entire multi-round pipeline before ever returning an HTTP `Response`. It's restructured to open the SSE stream immediately (same "TransformStream + background async writer" pattern already used by `streamDeepSeek`), then a new `runChatCompletionStream` inner function writes `status` frames at each phase transition and `token`/`error` frames as before, all into that one already-open stream.

**Tech Stack:** Cloudflare Workers, Vitest, vanilla JS/SSE in `chat.html` (no build step, no frontend test framework).

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-08-chat-progress-indicator-design.md` — read it if anything below is ambiguous.
- Files touched: `worker/src/index.js`, `worker/test/runChatCompletion.test.js`, `worker/test/statusForToolCalls.test.js` (new), `chat.html`. Nothing else.
- Never touch `wrangler.toml`, `worker/src/bggTools.js`, `worker/src/rateLimiter.js`, `worker/src/deepDiveContext.js`.
- Status codes are exactly: `thinking`, `searching`, `details`, `forum`, `writing`. The backend sends only the code (`data: {"status": "<code>"}`); `chat.html` owns the label text/emoji per language.
- Stall threshold: 8000ms (8s) of no new SSE frame within the current phase, only while no token has arrived yet (`fullText === ''`).
- Run backend tests with `cd worker && npm test` from the repo root.
- `chat.html` has no test framework — verification for it is manual (`wrangler dev` + browser or `curl -N`).

---

## Task 1: Restructure `runChatCompletion` to a stream-first architecture (no new status frames yet)

**Files:**
- Modify: `worker/src/index.js:61-70` (add `sseErrorFormat`), `worker/src/index.js:319-379` (replace `runChatCompletion`)
- Modify: `worker/test/runChatCompletion.test.js` (3 existing tests need to drain the response; 1 new test for the error path)

**Interfaces:**
- Produces: `runChatCompletion(messages, env, request, language = 'es')` — same public signature and behavior as today, but the `Response` it returns now resolves as soon as the stream opens, not after all rounds finish. Callers (tests, `handleChat`) must `await readAllText(response)` (already exported from `worker/test/sseHelpers.js`) to wait for the background processing to finish.
- Produces (internal, not exported): `runChatCompletionStream(messages, env, language, write)`, where `write` is `(frame: string) => Promise<void>` — writes one raw SSE frame (e.g. `data: {"token":"hi"}\n\n`) into the open stream. Task 2 will add `write(sseStatusFormat(...))` calls inside this function.

---

- [ ] **Step 1: Read the current `runChatCompletion` to confirm line numbers haven't drifted**

```bash
cd worker && grep -n "^async function runChatCompletion" src/index.js
```

Expected: `319:async function runChatCompletion(messages, env, request, language = 'es') {`. If the line number differs, the file has changed since this plan was written — re-read `src/index.js` before continuing and adjust the edits below by content, not line number.

- [ ] **Step 2: Add `sseErrorFormat` next to `sseFormat`**

In `worker/src/index.js`, find:

```js
function sseFormat(token) {
  return `data: ${JSON.stringify({ token })}\n\n`;
}
```

Replace with:

```js
function sseFormat(token) {
  return `data: ${JSON.stringify({ token })}\n\n`;
}

function sseErrorFormat(message) {
  return `data: ${JSON.stringify({ error: message })}\n\n`;
}
```

- [ ] **Step 3: Replace `runChatCompletion` with the stream-first version**

Find the entire current function (from `async function runChatCompletion(messages, env, request, language = 'es') {` through its closing `}` before `async function handleGetGames`):

```js
async function runChatCompletion(messages, env, request, language = 'es') {
  let currentMessages = messages;
  let toolsWereCalled = false;
  let hitToolRoundCap = false;

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    let result;
    try {
      result = await attemptBufferedRoundWithRetry(
        currentMessages,
        (msgs) => callGemini(msgs, env.GEMINI_API_KEY, { tools: BGG_TOOL_DEFINITIONS }),
        `round 1 (tool round ${round})`,
        isIncompleteStream
      );
    } catch (e) {
      return sseError(request, e.message);
    }

    if (result === null) {
      return replayBufferedAsSSE([fallbackMessage(language)], request);
    }

    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      if (!toolsWereCalled) {
        return replayBufferedAsSSE(result.bufferedTokens, request);
      }
      break;
    }

    toolsWereCalled = true;
    const toolCalls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    const toolMessages = await executeToolCalls(toolCalls, env);
    currentMessages = [...currentMessages, toolCallsAssistantMessage(toolCalls), ...toolMessages];

    if (round === MAX_TOOL_ROUNDS) {
      hitToolRoundCap = true;
    }
  }

  const synthesisMessages = hitToolRoundCap
    ? [...currentMessages, noMoreToolsNote(language)]
    : currentMessages;

  let secondResult;
  try {
    secondResult = await attemptBufferedRoundWithRetry(
      synthesisMessages,
      (msgs) => callDeepSeek(msgs, env.DEEPSEEK_API_KEY),
      'round 2',
      (result) => isIncompleteStream(result) || looksLikeLeakedToolCall(result.bufferedTokens.join(''))
    );
  } catch (e) {
    return sseError(request, e.message);
  }

  if (secondResult === null) {
    return replayBufferedAsSSE([fallbackMessage(language)], request);
  }

  return replayBufferedAsSSE(secondResult.bufferedTokens, request);
}
```

Replace it with:

```js
async function runChatCompletionStream(messages, env, language, write) {
  let currentMessages = messages;
  let toolsWereCalled = false;
  let hitToolRoundCap = false;

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const result = await attemptBufferedRoundWithRetry(
      currentMessages,
      (msgs) => callGemini(msgs, env.GEMINI_API_KEY, { tools: BGG_TOOL_DEFINITIONS }),
      `round 1 (tool round ${round})`,
      isIncompleteStream
    );

    if (result === null) {
      await write(sseFormat(fallbackMessage(language)));
      return;
    }

    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      if (!toolsWereCalled) {
        for (const token of result.bufferedTokens) await write(sseFormat(token));
        return;
      }
      break;
    }

    toolsWereCalled = true;
    const toolCalls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    const toolMessages = await executeToolCalls(toolCalls, env);
    currentMessages = [...currentMessages, toolCallsAssistantMessage(toolCalls), ...toolMessages];

    if (round === MAX_TOOL_ROUNDS) {
      hitToolRoundCap = true;
    }
  }

  const synthesisMessages = hitToolRoundCap
    ? [...currentMessages, noMoreToolsNote(language)]
    : currentMessages;

  const secondResult = await attemptBufferedRoundWithRetry(
    synthesisMessages,
    (msgs) => callDeepSeek(msgs, env.DEEPSEEK_API_KEY),
    'round 2',
    (result) => isIncompleteStream(result) || looksLikeLeakedToolCall(result.bufferedTokens.join(''))
  );

  if (secondResult === null) {
    await write(sseFormat(fallbackMessage(language)));
    return;
  }

  for (const token of secondResult.bufferedTokens) await write(sseFormat(token));
}

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

Note what changed: every `try { ... } catch (e) { return sseError(request, e.message) }` around an individual round is gone — a thrown error from `callGemini`/`callDeepSeek` (e.g. a non-ok HTTP response) now propagates up through `runChatCompletionStream` uncaught, to the single `try/catch` in `runChatCompletion`'s background function, which writes it as an `error` frame into the stream instead of returning a fresh `Response` (a second `Response` can't be returned — one was already handed back to the runtime when the stream opened).

- [ ] **Step 4: Run the existing test suite — expect 3 failures**

```bash
npm test -- runChatCompletion 2>&1 | tail -60
```

Expected: most tests pass, but these 3 fail (they call `await runChatCompletion(...)` and immediately assert on `mockFetch`/`executeBggTool` without draining the now-async-in-the-background stream first — a race, not a logic bug):
- `calls Gemini for both the tool round and the confirmation round, then DeepSeek for synthesis`
- `executes at most 3 tool calls per round`
- `caps tool-calling at 2 rounds and tells the synthesis model no more lookups are available`

- [ ] **Step 5: Fix the 3 racing tests by draining the response first**

In `worker/test/runChatCompletion.test.js`, find:

```js
    await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest());

    expect(mockFetch.mock.calls[0][0]).toBe(GEMINI_URL);
```

Replace with:

```js
    const response = await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest());
    await readAllText(response);

    expect(mockFetch.mock.calls[0][0]).toBe(GEMINI_URL);
```

Find:

```js
    await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());

    expect(executeBggTool).toHaveBeenCalledTimes(3);
  });

  it('passes a tool execution error through as the tool message content without aborting', async () => {
```

Replace with:

```js
    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    expect(executeBggTool).toHaveBeenCalledTimes(3);
  });

  it('passes a tool execution error through as the tool message content without aborting', async () => {
```

Find:

```js
    await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());

    // Two Gemini tool rounds + one DeepSeek synthesis call — never a third Gemini round.
    expect(mockFetch).toHaveBeenCalledTimes(3);
```

Replace with:

```js
    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    // Two Gemini tool rounds + one DeepSeek synthesis call — never a third Gemini round.
    expect(mockFetch).toHaveBeenCalledTimes(3);
```

- [ ] **Step 6: Run tests again — expect all green**

```bash
npm test -- runChatCompletion 2>&1 | tail -30
```

Expected: `Tests  13 passed (13)` (the original 13 tests, unchanged behavior).

- [ ] **Step 7: Write a new failing test for the consolidated error path**

Add this test to `worker/test/runChatCompletion.test.js`, right after the last existing `it(...)` block (before the closing `});` of the `describe` block):

```js
  it('writes an error frame into the stream when a round fails with a non-retryable error', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(fakeSSEResponse([], { ok: false, status: 500 }));
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    expect(text).toContain('"error":"Gemini API error: 500');
    expect(text).toContain('data: [DONE]');
  });
```

This should already pass given Step 3's implementation (it's confirming the new architecture works, not driving new production code) — run it to make sure:

```bash
npm test -- runChatCompletion 2>&1 | tail -30
```

Expected: `Tests  14 passed (14)`.

- [ ] **Step 8: Run the full worker suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all test files pass (this touches shared helpers, so `deepseekStream.test.js` etc. must still be green).

- [ ] **Step 9: Commit**

```bash
git add worker/src/index.js worker/test/runChatCompletion.test.js
git commit -m "refactor: open the chat SSE stream immediately instead of buffering the whole response

Restructures runChatCompletion so the Response is returned as soon as
the stream opens, with round-processing running in a background
function that writes frames into it — same pattern streamDeepSeek
already uses, now covering the whole request. No behavior change yet;
this is the prerequisite for streaming live status events (next
commit). Error handling is consolidated into one top-level catch that
writes an error frame instead of returning a fresh Response, since a
second Response can no longer be returned once the stream is open."
```

---

## Task 2: Emit `status` frames at each phase transition

**Files:**
- Modify: `worker/src/index.js` (add `sseStatusFormat`, `statusForToolCalls`, export `statusForToolCalls`, wire 3 `write(sseStatusFormat(...))` calls into `runChatCompletionStream`)
- Create: `worker/test/statusForToolCalls.test.js`
- Modify: `worker/test/runChatCompletion.test.js` (add `extractStatuses` helper, extend 3 tests with status-sequence assertions)

**Interfaces:**
- Consumes: `runChatCompletionStream(messages, env, language, write)` from Task 1 — same signature, no changes to it from outside this task.
- Produces: `statusForToolCalls(toolCalls)` — exported from `worker/src/index.js`, takes an array of `{ function: { name } }` objects (same shape as `result.toolCalls` from `parseDeepSeekStream`), returns one of `'searching' | 'details' | 'forum'`.

---

- [ ] **Step 1: Write the failing unit tests for `statusForToolCalls`**

Create `worker/test/statusForToolCalls.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { statusForToolCalls } from '../src/index.js';

function toolCall(name) {
  return { function: { name } };
}

describe('statusForToolCalls', () => {
  it('returns "searching" for a single bgg_search_game call', () => {
    expect(statusForToolCalls([toolCall('bgg_search_game')])).toBe('searching');
  });

  it('returns "details" for a single bgg_get_game_details call', () => {
    expect(statusForToolCalls([toolCall('bgg_get_game_details')])).toBe('details');
  });

  it('returns "forum" for a single bgg_search_forum call', () => {
    expect(statusForToolCalls([toolCall('bgg_search_forum')])).toBe('forum');
  });

  it('returns "forum" for a single bgg_get_thread call', () => {
    expect(statusForToolCalls([toolCall('bgg_get_thread')])).toBe('forum');
  });

  it('returns "details" when multiple calls repeat the same non-search tool', () => {
    expect(
      statusForToolCalls([toolCall('bgg_get_game_details'), toolCall('bgg_get_game_details')])
    ).toBe('details');
  });

  it('falls back to "searching" for a mixed set of tool names', () => {
    expect(
      statusForToolCalls([toolCall('bgg_search_game'), toolCall('bgg_get_game_details')])
    ).toBe('searching');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- statusForToolCalls 2>&1 | tail -30
```

Expected: FAIL — `statusForToolCalls` is not exported from `../src/index.js` yet (`SyntaxError` or `undefined is not a function`).

- [ ] **Step 3: Add `sseStatusFormat` and `statusForToolCalls` to `worker/src/index.js`**

Right after `sseErrorFormat` (added in Task 1):

```js
function sseStatusFormat(status) {
  return `data: ${JSON.stringify({ status })}\n\n`;
}
```

Right after `noMoreToolsNote` (just before `runChatCompletionStream`):

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

- [ ] **Step 4: Export `statusForToolCalls`**

Find the export line at the bottom of `worker/src/index.js`:

```js
export { callDeepSeek, parseDeepSeekStream, streamDeepSeek, replayBufferedAsSSE, runChatCompletion };
```

Replace with:

```js
export { callDeepSeek, parseDeepSeekStream, streamDeepSeek, replayBufferedAsSSE, runChatCompletion, statusForToolCalls };
```

- [ ] **Step 5: Run the unit tests again — verify they pass**

```bash
npm test -- statusForToolCalls 2>&1 | tail -30
```

Expected: `Tests  6 passed (6)`.

- [ ] **Step 6: Write the failing integration tests for status-frame ordering**

In `worker/test/runChatCompletion.test.js`, add this helper right after the `incompleteStreamSSE` definition (before `const env = ...`):

```js
function extractStatuses(text) {
  return [...text.matchAll(/data: (\{.*?\})\n/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    })
    .filter((frame) => frame && frame.status)
    .map((frame) => frame.status);
}
```

Extend the `replays buffered content when no tool call is requested` test — find:

```js
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(text).toContain('data: {"token":"Hola"}');
    expect(text).toContain('data: [DONE]');
    expect(executeBggTool).not.toHaveBeenCalled();
  });
```

Replace with:

```js
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(text).toContain('data: {"token":"Hola"}');
    expect(text).toContain('data: [DONE]');
    expect(executeBggTool).not.toHaveBeenCalled();
    expect(extractStatuses(text)).toEqual(['thinking']);
  });
```

Extend the `executes a requested tool call and streams the follow-up answer` test — find:

```js
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(executeBggTool).toHaveBeenCalledWith('bgg_search_game', { query: 'Wingspan' }, 'bgg-token');
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');
```

Replace with:

```js
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(executeBggTool).toHaveBeenCalledWith('bgg_search_game', { query: 'Wingspan' }, 'bgg-token');
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');
    expect(extractStatuses(text)).toEqual(['thinking', 'searching', 'thinking', 'writing']);
```

Extend the `caps tool-calling at 2 rounds and tells the synthesis model no more lookups are available` test — find:

```js
    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    // Two Gemini tool rounds + one DeepSeek synthesis call — never a third Gemini round.
    expect(mockFetch).toHaveBeenCalledTimes(3);
```

Replace with:

```js
    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    // Two Gemini tool rounds + one DeepSeek synthesis call — never a third Gemini round.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(extractStatuses(text)).toEqual(['thinking', 'searching', 'thinking', 'searching', 'writing']);
```

- [ ] **Step 7: Run the tests — verify the 3 status assertions fail, everything else still passes**

```bash
npm test -- runChatCompletion 2>&1 | tail -60
```

Expected: 3 failures, each `expected [] to equal [ 'thinking' ]` (or similar) — no `status` frames are written yet.

- [ ] **Step 8: Wire the status writes into `runChatCompletionStream`**

In `worker/src/index.js`, inside `runChatCompletionStream` (added in Task 1), make these three additions:

Find the top of the `for` loop:

```js
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const result = await attemptBufferedRoundWithRetry(
```

Replace with:

```js
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    await write(sseStatusFormat('thinking'));

    const result = await attemptBufferedRoundWithRetry(
```

Find:

```js
    toolsWereCalled = true;
    const toolCalls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    const toolMessages = await executeToolCalls(toolCalls, env);
```

Replace with:

```js
    toolsWereCalled = true;
    const toolCalls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    await write(sseStatusFormat(statusForToolCalls(toolCalls)));
    const toolMessages = await executeToolCalls(toolCalls, env);
```

Find:

```js
  const synthesisMessages = hitToolRoundCap
    ? [...currentMessages, noMoreToolsNote(language)]
    : currentMessages;

  const secondResult = await attemptBufferedRoundWithRetry(
```

Replace with:

```js
  const synthesisMessages = hitToolRoundCap
    ? [...currentMessages, noMoreToolsNote(language)]
    : currentMessages;

  await write(sseStatusFormat('writing'));

  const secondResult = await attemptBufferedRoundWithRetry(
```

- [ ] **Step 9: Run the tests — verify everything passes**

```bash
npm test 2>&1 | tail -30
```

Expected: all test files pass, full suite green.

- [ ] **Step 10: Commit**

```bash
git add worker/src/index.js worker/test/runChatCompletion.test.js worker/test/statusForToolCalls.test.js
git commit -m "feat: stream phase-status SSE events during chat completion

Emits a status frame (thinking/searching/details/forum/writing)
before each Gemini tool round and before the final DeepSeek synthesis
call, so the client can show what's happening instead of a static
cursor for the 6-12s the multi-round pipeline takes. Backend sends
only a status code; chat.html (next commit) owns the label text."
```

---

## Task 3: Show phase labels and a stall reassurance in `chat.html`

**Files:**
- Modify: `chat.html` (CSS block, `addStreamingMessage()`, `sendMessage()`)

**Interfaces:**
- Consumes: SSE frames from `POST /api/chat` — `{"status": "<code>"}`, `{"token": "<text>"}`, `{"error": "<message>"}`, and the literal `[DONE]` sentinel (unchanged frame shapes plus the new `status` key from Task 2).

---

- [ ] **Step 1: Add the CSS for the status label and stall note**

In `chat.html`, find:

```css
    .cursor { display: inline-block; animation: blink 0.8s step-end infinite; }
    @keyframes blink { 50% { opacity: 0; } }
```

Replace with:

```css
    .cursor { display: inline-block; animation: blink 0.8s step-end infinite; }
    @keyframes blink { 50% { opacity: 0; } }

    .status-label { color: #777; font-style: italic; }
    .stall-note { color: #999; font-size: 13px; margin-top: 4px; font-style: italic; }
```

- [ ] **Step 2: Add the `STATUS_LABELS` table**

Find:

```js
  let history = [];
  let streaming = false;
```

Replace with:

```js
  let history = [];
  let streaming = false;

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

- [ ] **Step 3: Change `addStreamingMessage()`'s default state**

Find:

```js
  function addStreamingMessage() {
    const container = document.getElementById('chat-container');
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = '<span class="cursor">▋</span>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }
```

Replace with:

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

- [ ] **Step 4: Add the stall timer and status handling in `sendMessage()`**

Find:

```js
    const streamDiv = addStreamingMessage();
    let fullText = '';

    try {
```

Replace with:

```js
    const streamDiv = addStreamingMessage();
    let fullText = '';
    let lastEventTime = Date.now();

    const stallInterval = setInterval(() => {
      if (fullText !== '') return;
      const elapsed = Math.floor((Date.now() - lastEventTime) / 1000);
      if (elapsed < 8) return;
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
    }, 1000);

    try {
```

Find:

```js
          if (data === '[DONE]') {
            streamDiv.innerHTML = renderMarkdown(fullText);
            history.push({ role: 'user', content: userText });
            history.push({ role: 'assistant', content: fullText });
            finished = true;
            break;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              streamDiv.className = 'message error';
              streamDiv.textContent = parsed.error;
              finished = true;
              break;
            }
            if (parsed.token) {
              fullText += parsed.token;
              streamDiv.innerHTML = renderMarkdown(fullText) + '<span class="cursor">▋</span>';
              document.getElementById('chat-container').scrollTop =
                document.getElementById('chat-container').scrollHeight;
            }
          } catch {}
```

Replace with:

```js
          if (data === '[DONE]') {
            clearInterval(stallInterval);
            streamDiv.innerHTML = renderMarkdown(fullText);
            history.push({ role: 'user', content: userText });
            history.push({ role: 'assistant', content: fullText });
            finished = true;
            break;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              clearInterval(stallInterval);
              streamDiv.className = 'message error';
              streamDiv.textContent = parsed.error;
              finished = true;
              break;
            }
            if (parsed.status) {
              lastEventTime = Date.now();
              const label = (STATUS_LABELS[currentLanguage] && STATUS_LABELS[currentLanguage][parsed.status])
                || STATUS_LABELS[currentLanguage].thinking;
              streamDiv.innerHTML = `<span class="status-label">${label}</span>`;
            }
            if (parsed.token) {
              lastEventTime = Date.now();
              fullText += parsed.token;
              streamDiv.innerHTML = renderMarkdown(fullText) + '<span class="cursor">▋</span>';
              document.getElementById('chat-container').scrollTop =
                document.getElementById('chat-container').scrollHeight;
            }
          } catch {}
```

Find:

```js
    } catch (e) {
      streamDiv.className = 'message error';
      streamDiv.innerHTML = 'Error al conectar con el asistente. Intenta de nuevo.';
    }
```

Replace with:

```js
    } catch (e) {
      clearInterval(stallInterval);
      streamDiv.className = 'message error';
      streamDiv.innerHTML = 'Error al conectar con el asistente. Intenta de nuevo.';
    }
```

- [ ] **Step 5: Commit**

```bash
git add chat.html
git commit -m "feat: show live phase status and a stall reassurance while waiting for chat replies

addStreamingMessage() now starts with a 'thinking' label instead of a
bare cursor, updates it as status frames arrive from the backend
(thinking/searching/details/forum/writing, mapped per language), and
shows a live-incrementing 'taking longer than usual' note if a phase
goes 8s without a new frame. Clears cleanly on completion, error, or
network failure."
```

---

## Task 4: Manual end-to-end verification

**Files:** none (verification only)

---

- [ ] **Step 1: Start the worker locally**

```bash
cd worker && npx wrangler dev --port 8787
```

Expected: `[wrangler:info] Ready on http://localhost:8787` with no errors.

- [ ] **Step 2: Watch raw SSE frames for a multi-tool-call question**

In a second terminal:

```bash
curl -sS -N -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  -d '{"message":"Busca en BoardGameGeek el juego Ark Nova y dime su rating y complejidad","history":[],"mode":"discovery","language":"es"}'
```

Expected: the first lines are `data: {"status":"thinking"}`, then `data: {"status":"searching"}`, then another `data: {"status":"thinking"}`, then `data: {"status":"details"}`, then `data: {"status":"writing"}`, then a stream of `data: {"token":"..."}` lines forming a real answer with rating and complexity, ending in `data: [DONE]`.

- [ ] **Step 3: Open `chat.html` against the local worker and confirm the UI**

Edit `chat.html` temporarily (do not commit this) to point `WORKER_URL` at `http://localhost:8787`, or serve it with any static server and adjust CORS `Origin` handling as needed. Open it in a browser, ask the same Ark Nova question, and confirm:
- The assistant bubble starts with "💭 Pensando..." immediately (no blank cursor).
- The label visibly changes through "🔍 Buscando..." → "💭 Pensando..." → "📖 Consultando detalles..." → "✍️ Escribiendo respuesta..." before real text appears.
- Once tokens start, the label disappears and normal markdown-rendered text streams in as before.
- Revert the temporary `WORKER_URL` edit once done.

- [ ] **Step 4: Confirm the stall note appears on a slow phase**

Ask a question likely to hit the DSML-leak retry (e.g. a question needing a second BGG lookup the model doesn't get right away — the Patchwork solo-mode question used earlier this session is a good candidate) enough times to catch one that takes over 8s in a single phase. Confirm the "Esto está tardando más de lo usual (Ns)..." line appears below the phase label and the seconds count climbs, then disappears/gets replaced once the phase advances or the answer arrives.

- [ ] **Step 5: Confirm error paths still surface visibly**

Temporarily set an invalid `GEMINI_API_KEY` in `worker/.dev.vars`, restart `wrangler dev`, ask any question, and confirm the chat UI shows a visible error bubble (not a stuck "Pensando..."). Restore the real key afterward and restart `wrangler dev` again.

- [ ] **Step 6: Stop the local server**

```bash
pkill -f "wrangler dev"
```

No commit for this task — it's verification only. If any step reveals a bug, fix it in the relevant Task 1–3 file, re-run that task's tests, and re-verify here before considering the plan complete.

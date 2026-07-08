# Gemini Round 1 Tool-Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DeepSeek with Gemini 2.5 Flash-Lite in Round 1 (tool-calling decision) to eliminate the DSML leak bug that makes the BGG chat inutilizable.

**Architecture:** Two-round chat flow: Gemini decides whether to call BGG tools (Round 1, reliable), DeepSeek synthesizes the final answer from tool results (Round 2, unchanged). The BGG tool execution logic between rounds does not change. Both models use the same OpenAI-compatible SSE format, so the existing SSE parser works for both.

**Tech Stack:** Cloudflare Workers, Vitest, Gemini `/v1beta/openai/` endpoint (OpenAI-compatible), DeepSeek API.

## Global Constraints

- All code changes are in `worker/` — never touch `chat.html` or `wrangler.toml`
- Run tests with `cd worker && npm test` from the repo root
- Gemini model ID: `gemini-2.5-flash-lite` — verify the exact ID at https://ai.google.dev/gemini-api/docs/openai before implementing (may have a version suffix)
- Gemini endpoint: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- The `GEMINI_API_KEY` secret uses Google AI Studio format: starts with `AIza`
- Never commit `.dev.vars` — it is gitignored and holds local secrets

---

## File Map

| File | Change |
|------|--------|
| `worker/src/index.js` | Add `callGemini`; refactor `attemptBufferedRound` to accept `callFn`; update `runChatCompletion` (Gemini Round 1, DeepSeek Round 2, remove `language` param); update `handleChat` call site; delete `looksLikeLeakedToolCall`, `fallbackMessage`, `bufferedRoundWithLeakRetry` |
| `worker/test/runChatCompletion.test.js` | Add `GEMINI_API_KEY` to `env`; add Gemini URL verification test; delete `dsmlLeakSSE`; delete 5 DSML test cases |
| `.dev.vars` | Add `GEMINI_API_KEY=AIza...` |

---

## Task 1: Migrate chat completions to Gemini for Round 1

**Files:**
- Modify: `worker/src/index.js`
- Modify: `worker/test/runChatCompletion.test.js`

**Interfaces:**
- Produces: `runChatCompletion(messages, env, request)` — same signature as before minus the unused `language` param; `env` now requires `GEMINI_API_KEY` in addition to `DEEPSEEK_API_KEY` and `BGG_TOKEN`

---

- [ ] **Step 1: Write the failing test and update `env`**

Open `worker/test/runChatCompletion.test.js`. Make two changes:

**1a. Update `env` (line 58) to include the new key:**

```javascript
// Before:
const env = { DEEPSEEK_API_KEY: 'key123', BGG_TOKEN: 'bgg-token' };

// After:
const env = { DEEPSEEK_API_KEY: 'key123', GEMINI_API_KEY: 'test-gemini-key', BGG_TOKEN: 'bgg-token' };
```

**1b. Add a new test immediately after the existing `afterEach` block (after line 64), before the first `it(...)` block:**

```javascript
it('calls Gemini API for round 1 and DeepSeek for round 2', async () => {
  executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce(
      toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }])
    )
    .mockResolvedValueOnce(
      fakeSSEResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ])
    );
  vi.stubGlobal('fetch', mockFetch);

  await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest());

  expect(mockFetch.mock.calls[0][0]).toBe(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  );
  expect(mockFetch.mock.calls[1][0]).toBe('https://api.deepseek.com/chat/completions');
});
```

- [ ] **Step 2: Run the new test to verify it fails**

```bash
cd worker && npm test -- --reporter=verbose runChatCompletion
```

Expected: the new test FAILS with something like:
```
AssertionError: expected 'https://api.deepseek.com/chat/completions' to be 'https://generativelanguage.googleapis.com/...'
```
All other existing tests should still pass.

- [ ] **Step 3: Add `callGemini` to `worker/src/index.js`**

Insert this function immediately after the closing `}` of `callDeepSeek` (currently at line 89), before `parseDeepSeekStream`:

```javascript
async function callGemini(messages, apiKey, { tools } = {}) {
  const body = { model: 'gemini-2.5-flash-lite', messages, stream: true };
  if (tools) body.tools = tools;

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
  return response;
}
```

- [ ] **Step 4: Delete `looksLikeLeakedToolCall`, `fallbackMessage`, and `bufferedRoundWithLeakRetry`**

Remove these three functions entirely from `worker/src/index.js`:

```javascript
// DELETE this block (lines ~197-199):
function looksLikeLeakedToolCall(text) {
  return text.includes('DSML');
}

// DELETE this block (lines ~201-205):
function fallbackMessage(language) {
  return language === 'en'
    ? 'I ran into a problem answering that. Could you rephrase your question?'
    : 'Tuve un problema respondiendo eso. ¿Podés reformular la pregunta?';
}

// DELETE this block (lines ~216-230):
// DeepSeek's tool-calling occasionally leaks its internal DSML markup as plain
// content (finish_reason: "stop") instead of populating tool_calls, in either
// round. It's non-deterministic upstream, so a single retry is the cheap fix;
// returns null if it leaks twice in a row, so the caller can fall back.
async function bufferedRoundWithLeakRetry(messages, env, tools) {
  let result = await attemptBufferedRound(messages, env, tools);
  if (looksLikeLeakedToolCall(result.bufferedTokens.join(''))) {
    result = await attemptBufferedRound(messages, env, tools);
    if (looksLikeLeakedToolCall(result.bufferedTokens.join(''))) {
      console.error('DeepSeek leaked DSML tool-call markup twice in a row, falling back');
      return null;
    }
  }
  return result;
}
```

- [ ] **Step 5: Refactor `attemptBufferedRound` to accept a generic `callFn`**

Replace the current `attemptBufferedRound` function (lines ~207-214) with:

```javascript
async function attemptBufferedRound(messages, callFn) {
  const bufferedTokens = [];
  const response = await callFn(messages);
  const result = await parseDeepSeekStream(response, async (token) => {
    bufferedTokens.push(token);
  });
  return { ...result, bufferedTokens };
}
```

- [ ] **Step 6: Replace `runChatCompletion` with the updated implementation**

Replace the entire `runChatCompletion` function (currently lines ~232-294) with:

```javascript
async function runChatCompletion(messages, env, request) {
  let firstResult;
  try {
    firstResult = await attemptBufferedRound(
      messages,
      (msgs) => callGemini(msgs, env.GEMINI_API_KEY, { tools: BGG_TOOL_DEFINITIONS })
    );
  } catch (e) {
    return sseError(request, e.message);
  }

  if (firstResult.finishReason !== 'tool_calls' || firstResult.toolCalls.length === 0) {
    return replayBufferedAsSSE(firstResult.bufferedTokens, request);
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
        content: JSON.stringify(error ? { error } : { result }),
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

  let secondResult;
  try {
    secondResult = await attemptBufferedRound(
      followUp,
      (msgs) => callDeepSeek(msgs, env.DEEPSEEK_API_KEY)
    );
  } catch (e) {
    return sseError(request, e.message);
  }

  return replayBufferedAsSSE(secondResult.bufferedTokens, request);
}
```

- [ ] **Step 7: Update the `handleChat` call site**

In `handleChat` (around line 419), update the call to `runChatCompletion` to remove the now-unused `language` argument:

```javascript
// Before:
return runChatCompletion(messages, env, request, language);

// After:
return runChatCompletion(messages, env, request);
```

- [ ] **Step 8: Run tests — verify new test passes and DSML tests fail**

```bash
cd worker && npm test -- --reporter=verbose runChatCompletion
```

Expected: the new Gemini URL test PASSES; the 5 DSML tests FAIL (this is expected — their behavior no longer exists). All other tests (no-tool-call replay, tool execution, max 3 tools, error passthrough, no third round, malformed args) PASS.

- [ ] **Step 9: Delete `dsmlLeakSSE` from the test file**

In `worker/test/runChatCompletion.test.js`, remove this entire helper (lines ~42-56):

```javascript
const dsmlLeakSSE = () =>
  fakeSSEResponse([
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            content:
              '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bgg_get_game_details">\n<｜｜DSML｜｜parameter name="id" string="false">266192</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
          },
        },
      ],
    }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]);
```

- [ ] **Step 10: Delete the 5 DSML test cases**

Remove these 5 `it(...)` blocks from `worker/test/runChatCompletion.test.js`:

1. `'retries once when the model leaks raw DSML tool-call markup instead of using tool_calls, and uses the clean retry'` (~lines 172-186)
2. `'falls back to a friendly message when DSML leaks on both the initial attempt and the retry'` (~lines 188-202)
3. `'falls back to an English message when language is "en"'` (~lines 204-215)
4. `'retries round 2 once and uses the clean retry when the follow-up answer leaks DSML'` (~lines 217-237)
5. `'falls back to a friendly message when the follow-up answer leaks DSML on both attempts'` (~lines 239-254)

- [ ] **Step 11: Run all tests — verify everything passes**

```bash
cd worker && npm test
```

Expected output: all test suites pass, 0 failures. You should see 7 passing tests in `runChatCompletion.test.js` (6 original behavior tests + 1 new Gemini URL test).

- [ ] **Step 12: Commit**

```bash
git add worker/src/index.js worker/test/runChatCompletion.test.js
git commit -m "feat: use Gemini 2.5 Flash-Lite for Round 1 tool-calling

Replaces DeepSeek in the tool-calling round with Gemini, eliminating
the DSML leak bug. Round 2 synthesis remains on DeepSeek unchanged.
Removes all DSML retry/fallback code (~30 lines).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Configure GEMINI_API_KEY

**Files:**
- Modify: `.dev.vars`

**Interfaces:**
- Consumes: Google AI Studio API key (obtain at https://aistudio.google.com/app/apikey — free tier, no credit card)

---

- [ ] **Step 1: Add the key to `.dev.vars`**

Open `.dev.vars` (in the repo root or `worker/` — wherever the other keys live) and add:

```
GEMINI_API_KEY=AIza...
```

Replace `AIza...` with your actual key from Google AI Studio.

- [ ] **Step 2: Add the key to Cloudflare production**

```bash
cd worker && npx wrangler secret put GEMINI_API_KEY
```

When prompted, paste the same `AIza...` key. Wrangler will confirm:
```
✨ Success! Uploaded secret GEMINI_API_KEY
```

- [ ] **Step 3: Verify the worker starts locally**

```bash
cd worker && npm run dev
```

Expected: wrangler starts without errors. Send a test chat message via the UI at `http://localhost:8787` — the BGG discovery chat should respond correctly without DSML errors.

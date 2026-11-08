# Voice Input for Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hold-to-talk microphone button to `chat.html` that transcribes Spanish speech with Whisper (Cloudflare Workers AI) into the message box, for the user to review/edit and send.

**Architecture:** Browser records audio with `MediaRecorder` and POSTs the raw blob to a new Worker route `/api/transcribe`, which calls `@cf/openai/whisper-large-v3-turbo` (language forced to `es`, game name as `initial_prompt`) and returns the text. The Cloudflare Workers Free daily quota is the hard spending cap; when it is exhausted the Worker answers `503 voice_unavailable` and the client hides the mic so the chat keeps working by text. Client logic lives in a new ES module `voice-input.js` (unit-tested with fakes); `chat.html` only wires it.

**Tech Stack:** Cloudflare Worker (JS, vitest), Workers AI binding `AI` (already in `worker/wrangler.toml`), vanilla browser JS (ES module), GitHub Pages (publishes the whole repo root).

**Spec:** No separate spec doc. Agreed in the 2026-11-08 brainstorming conversation (summary under Global Constraints). Experiment results: Whisper beat Safari's `webkitSpeechRecognition` on the user's iPad; round trip was 991 ms, `audio/webm;codecs=opus` accepted directly. Throwaway lab: `voice-lab.html`, `worker/src/voiceLab.js` (removed in Task 5).

## Global Constraints

- Spanish only: Whisper is called with `language: 'es'`; the mic is hidden while `currentLanguage === 'en'`.
- Targets: iPad M1 / iPhone 13 mini, Safari only. Safari may record `audio/webm;codecs=opus` (18.4+) or `audio/mp4` (older); on `502 transcription_failed` the client retries once as WAV 16 kHz mono 16-bit.
- Hold-to-talk. Transcription goes into `#message-input` (appended, never replacing existing text) and is **never auto-sent**.
- Max recording 30 s (client auto-stop). Server rejects audio > 1,048,576 bytes (`413`).
- Spending is capped by the Cloudflare Workers Free plan (10,000 neurons/day, error code `3036`); no paid usage, no new API keys, no secret in the public page.
- Rate limit: 10 requests/min per IP, separate counter from chat (`prefix: 'voice'`). Each transcription costs one KV write (KV free plan has a daily write limit that was hit before).
- User-facing copy, exactly: `No te escuché, intenta de nuevo.` / `No se pudo transcribir, intenta de nuevo o escribe tu pregunta.` / `Permite el micrófono para el sitio en los ajustes de Safari.` / `La voz no está disponible por hoy. Escribe tu pregunta.`
- The Worker is NOT auto-deployed: `cd worker && npx wrangler deploy` is manual (and needs `npx wrangler login` if the session expired). GitHub Pages deploys on push to `master`.
- All `gh` commands use `--repo chardila/mybgg`. Never merge a PR without the user's explicit OK for that PR.
- Out of scope: spoken answers, hands-free mode, other languages.

## Review Focus

1. Finger released before the mic-permission prompt resolves → nothing left recording, no request sent (Task 3).
2. Very short tap (< 1000 bytes of audio) → note `No te escuché…`, no request, no quota used (Task 3).
3. Held past 30 s → auto-stops and transcribes what was captured (Task 3).
4. Daily quota exhausted (`503 voice_unavailable`) → mic hidden for the rest of the page's life, text chat unaffected; other failures show a temporary note and keep the mic (Tasks 1, 3).
5. Text already typed in the box is kept (transcription appended with a space); mic is unavailable while a reply is streaming, while the box is disabled awaiting expansion choice, and in English mode (Tasks 3, 4).

---

### Task 1: Production `/api/transcribe` endpoint

**Files:**
- Create: `worker/src/transcribe.js`
- Modify: `worker/src/rateLimiter.js` (add `prefix`), `worker/src/index.js` (route)
- Test: `worker/test/transcribeEndpoint.test.js`, `worker/test/rateLimiter.test.js`

**Interfaces:**
- Consumes: `checkRateLimit` from `rateLimiter.js`; `getCorsHeaders(request)` from `index.js` (passed in as a function, same pattern as `voiceLab.js`); `bytesToBase64(bytes: Uint8Array): string` already exists in `worker/src/voiceLab.js` — move it to `transcribe.js` and make `voiceLab.js` import and re-export it (keep `voiceLab.test.js` passing until Task 5 deletes both).
- Produces:
  - `checkRateLimit({ store, ip, now?, limit?, windowSeconds?, prefix = 'chat' })` — KV key becomes `ratelimit:${prefix}:${ip}:${windowStart}`.
  - `handleTranscribe(request: Request, env, getCorsHeaders): Promise<Response>` and `export const MAX_AUDIO_BYTES = 1048576`.
  - HTTP contract for `POST /api/transcribe?prompt=<≤400 chars>`, body = raw audio: `200 {text, ms}` · `400 {error:'empty_audio'}` · `413 {error:'audio_too_large'}` · `429 {error:'rate_limited'}` · `502 {error:'transcription_failed'}` (AI error that is not quota; do not leak the AI message) · `503 {error:'voice_unavailable'}` (no `AI` binding, or AI error matching `/\b3036\b|daily free allocation/i`).

- [ ] **Step 1: Write failing tests.** `rateLimiter.test.js`: with a Map-backed fake `store`, 20 calls with default prefix are allowed and the 21st is `{allowed:false}`, but a call with `prefix:'voice'` for the same ip is still `{allowed:true}`. `transcribeEndpoint.test.js` (fake `env = { AI, WIKI: mapStore }`): empty body → 400 `empty_audio`; body of `MAX_AUDIO_BYTES + 1` → 413 `audio_too_large` with `AI.run` not called; store pre-filled to the limit → 429 `rate_limited`; success calls `AI.run('@cf/openai/whisper-large-v3-turbo', { audio: <base64>, language: 'es', task: 'transcribe', initial_prompt: 'Pandemic Legacy' })` and returns `{text: 'hola', ms: <number>}` (AI returns `{text:' hola '}`); no `prompt` param → input has no `initial_prompt` key; prompt longer than 400 chars is truncated to 400; AI throws `Error('3036: You have used up your daily free allocation')` → 503 `voice_unavailable`; AI throws `Error('decode failed')` → 502 `transcription_failed` and the body does not contain `decode failed`; `env.AI` undefined → 503.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/transcribeEndpoint.test.js test/rateLimiter.test.js` — Expected: FAIL (module/option missing).
- [ ] **Step 3: Implement** `handleTranscribe` in `transcribe.js` following `voiceLab.js` (same Whisper call, same `bytesToBase64`), without the `X-Lab-Key` gate. Order: declared `Content-Length` > max → 413; rate limit (limit 10, `prefix:'voice'`, ip from `CF-Connecting-IP`) → 429; read body; empty → 400; actual length > max → 413; call AI with `ms` timing. Add `prefix` to `checkRateLimit`. In `index.js` import `handleTranscribe` and route `POST /api/transcribe`.
- [ ] **Step 4: Run** `cd worker && npx vitest run` — Expected: all tests PASS (existing 101 + new).
- [ ] **Step 5: Commit** `git add worker && git commit -m "feat(worker): add /api/transcribe with quota-aware errors"`

### Task 2: Client helpers and `transcribeBlob`

**Files:**
- Create: `voice-input.js` (ES module, repo root, served by Pages)
- Test: `worker/test/voiceClient.test.js` (imports `../../voice-input.js`)

**Interfaces:**
- Consumes: the Task 1 HTTP contract. `toWav16k` is lifted from `voice-lab.html` (already working on the user's iPad).
- Produces (all named exports):
  - `MAX_SECONDS = 30`, `MIN_AUDIO_BYTES = 1000`
  - `class VoiceUnavailableError extends Error`
  - `pickMime(MediaRecorderClass): string` — first supported of `['audio/webm;codecs=opus','audio/mp4','audio/webm']`, else `''`.
  - `buildVocabularyPrompt(gameName: string|null): string` — `''` for falsy, else `` `Juego de mesa: ${gameName}.` `` capped at 400 chars.
  - `toWav16k(blob: Blob): Promise<Blob>` (browser-only; not unit-tested).
  - `transcribeBlob(blob: Blob, opts?: { prompt?: string, workerUrl?: string, fetchImpl?: typeof fetch, convert?: (b: Blob) => Promise<Blob> }): Promise<string>` — POSTs to `${workerUrl}/api/transcribe` (+ `?prompt=` URL-encoded when non-empty) with `Content-Type: blob.type`; returns trimmed `text`; `503` → throws `VoiceUnavailableError`; `502` and `blob.type !== 'audio/wav'` → retries once with `convert(blob)`; any other non-ok → throws `Error(data.error || 'transcription_failed')`.

- [ ] **Step 1: Write failing tests** (fake `fetchImpl`): `pickMime` returns `'audio/mp4'` when only that is supported and `''` when none; `buildVocabularyPrompt(null)` → `''`, `('Azul')` → `'Juego de mesa: Azul.'`, 500-char name → length ≤ 400; `transcribeBlob` returns `'hola'` for `{text:' hola '}` and sends URL `/api/transcribe?prompt=Juego%20de%20mesa%3A%20Azul.`; 503 → rejects with `VoiceUnavailableError`; 502 then 200 → resolves and `convert` called once, second request body is the converted blob; 502 on a blob of type `audio/wav` → rejects `Error` without calling `convert`; 429 → rejects `Error('rate_limited')`.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/voiceClient.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the exports above in `voice-input.js`; copy `toWav16k` from `voice-lab.html` unchanged.
- [ ] **Step 4: Run** `cd worker && npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git add voice-input.js worker/test/voiceClient.test.js && git commit -m "feat: add voice-input client helpers"`

### Task 3: Hold-to-talk controller

**Files:**
- Modify: `voice-input.js`
- Test: `worker/test/voiceController.test.js`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: `createHoldToTalk({ button, getPrompt, onText, onNote, onUnavailable, deps? })` returning `{ isBusy(): boolean }`. `button` needs `addEventListener`, `setPointerCapture`, `dataset`. `deps` (all optional, for tests) = `{ getUserMedia, MediaRecorderClass, transcribe, setTimeoutFn, clearTimeoutFn }`, defaulting to `navigator.mediaDevices.getUserMedia`, `MediaRecorder`, `transcribeBlob`, `setTimeout`, `clearTimeout`. Sets `button.dataset.state` to `'idle' | 'recording' | 'transcribing'`. `onText(text)` receives the transcription; `onNote(message)` the exact copy from Global Constraints; `onUnavailable()` fires once on `VoiceUnavailableError`. Reuses one mic stream across presses. `pointerdown` is ignored unless state is `'idle'`.

- [ ] **Step 1: Write failing tests** (fake button recording handlers; fake recorder whose `stop()` emits one `ondataavailable` blob then `onstop`; `vi.useFakeTimers()`), one `it` each:
  - release before permission resolves (Review Focus 1): `getUserMedia` returns a deferred promise; fire `pointerdown`, `pointerup`, then resolve → recorder `start` never called, `transcribe` never called, state `'idle'`.
  - tap too short (2): blob of 500 bytes → `onNote('No te escuché, intenta de nuevo.')`, `transcribe` not called.
  - long hold (3): `pointerdown`, advance 30000 ms → recorder `stop` called and `transcribe` called once with `{ prompt: getPrompt() }`.
  - success: 5000-byte blob, `transcribe` resolves `'hola'` → `onText('hola')`, state `'idle'`, `onNote` not called.
  - quota (4): `transcribe` rejects `VoiceUnavailableError` → `onUnavailable` called once, `onNote` not called, state `'idle'`.
  - generic failure (4): `transcribe` rejects `Error('x')` → `onNote('No se pudo transcribir, intenta de nuevo o escribe tu pregunta.')`, `onUnavailable` not called.
  - permission denied: `getUserMedia` rejects `{name:'NotAllowedError'}` → `onNote('Permite el micrófono para el sitio en los ajustes de Safari.')`, state `'idle'`.
  - second `pointerdown` while `'recording'` or `'transcribing'` → `getUserMedia`/recorder constructed only once.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/voiceController.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `createHoldToTalk`. Key points from the lab bug: the recorder's `onstop` must use a local reference (never the shared variable that `stop` nulls), and a `wantStop` flag handles release during the permission prompt.
- [ ] **Step 4: Run** `cd worker && npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git add voice-input.js worker/test/voiceController.test.js && git commit -m "feat: hold-to-talk controller for voice input"`

### Task 4: Wire the mic button into `chat.html`

**Files:**
- Modify: `chat.html` (button inside `.input-bar` before `#send-btn`, CSS, a `<script type="module">` that imports from `./voice-input.js`)

**Interfaces:**
- Consumes: `createHoldToTalk`, `buildVocabularyPrompt` from `voice-input.js`; existing globals `currentLanguage`, `currentGameName`, `streaming`, and `#message-input`.
- Produces: `window.syncMic()` — shows `#mic-btn` only when `navigator.mediaDevices` and `MediaRecorder` exist, `currentLanguage === 'es'`, and voice has not been marked unavailable; disables it while `streaming` or `#message-input` is disabled. Call it from `setLanguage`, `sendMessage` (start and end), and `setAwaitingCombo`. `onText` appends to the textarea (`existing ? existing + ' ' + text : text`), focuses it. `onNote` shows the text in a small `#voice-note` line above the input bar that clears after 4 s. `onUnavailable` sets the unavailable flag, hides the mic, and shows `La voz no está disponible por hoy. Escribe tu pregunta.`. `getPrompt` = `() => buildVocabularyPrompt(currentGameName)`. Button needs `touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none` (as in `voice-lab.html`).

- [ ] **Step 1: Implement** the markup, CSS and module script.
- [ ] **Step 2: Verify the visibility rules** with `python3 -m http.server 8765` from the repo root and the chrome-devtools MCP on `http://localhost:8765/chat.html` (games fetch will fail; that is fine): with `evaluate_script` confirm `#mic-btn` is displayed in ES mode, hidden after `setLanguage('en')`, displayed again after `setLanguage('es')`, and `disabled` after `setAwaitingCombo(true)`. Expected: all four as stated, no console errors other than the `/api/games` failure.
- [ ] **Step 3: Verify text append** in the same session: set `#message-input` value to `ya tengo`, then dispatch the `onText` path via a stubbed `transcribe` (or call the exported append helper) and confirm the value becomes `ya tengo hola` and nothing was sent (no `/api/chat` request in the network list).
- [ ] **Step 4: Commit** `git add chat.html && git commit -m "feat(chat): hold-to-talk mic button"`

### Task 5: Remove the lab, deploy, verify on the iPad

**Files:**
- Delete: `voice-lab.html`, `worker/src/voiceLab.js`, `worker/test/voiceLab.test.js`
- Modify: `worker/src/index.js` (drop the lab import and `/api/lab/transcribe` route; `Access-Control-Allow-Headers` back to `'Content-Type'`)

- [ ] **Step 1: Delete and edit** as listed. Run `cd worker && npx vitest run` — Expected: PASS with the lab tests gone.
- [ ] **Step 2: Commit and open the PR** (`git push -u origin feat/voice-input`, then `gh pr create --repo chardila/mybgg --base master`). **Stop and ask the user for explicit approval before merging.**
- [ ] **Step 3: With the user's approval, deploy the Worker first, from the branch** (`cd worker && npx wrangler deploy`), so `/api/transcribe` exists before the new page goes live. Smoke-test it (Step 4, first two checks). Then, with approval to merge, merge the PR and run `npx wrangler secret delete LAB_KEY`.
- [ ] **Step 4: Production smoke test.** `curl -s -o /dev/null -w '%{http_code}' -X POST https://bgg.cardila.com/api/transcribe` → `400`; with `--data-binary 'not-audio'` → `502`; after merge and the Pages redeploy, `curl -s -o /dev/null -w '%{http_code}' https://bgg.cardila.com/voice-lab.html` → `404`; `/api/health` → `ok`.
- [ ] **Step 5: iPad check by the user.** Ask the user to reload `https://bgg.cardila.com/chat.html` and: (a) hold the mic and ask a real in-game question in Spanish → text appears in the box, not sent; (b) edit it and send; (c) type something, then dictate → both are kept; (d) switch to EN → mic disappears. Record the outcome.

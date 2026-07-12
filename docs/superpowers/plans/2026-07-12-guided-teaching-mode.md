# Guided Teaching Mode ("Enséñame a jugar") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third chat mode, `teach`, that proactively walks a beginner (child or non-gamer adult) through learning a board game block-by-block in Spanish, reusing the existing `deep_dive` context-building and streaming infrastructure.

**Architecture:** Three independent, additive changes across the existing pipeline — no new services, no new storage, no new state. (1) The `teaching` section's LLM generation prompt in `mybgg-wiki`'s compiler is rewritten to produce Spanish, learner-facing blocks instead of English instructor notes. (2) The Worker gets a new `SYSTEM_PROMPTS.teach` entry and a merged request-handling branch (`mode === 'deep_dive' || mode === 'teach'`) that reuses the same KV fetch and `buildDeepDiveContext` call, only swapping which prompt function is used. (3) `chat.html` gets a second button next to "Empezar" that starts the same flow with `mode = 'teach'`.

**Tech Stack:** Python (compiler, `scripts/compiler/llm_compiler.py`, tested with `pytest`), Cloudflare Worker JavaScript (`worker/src/index.js`, tested with `vitest`), static HTML/vanilla JS (`chat.html`, no test harness in this repo — verified manually).

**Full design context:** `docs/superpowers/specs/2026-07-12-guided-teaching-mode-design.md`

## Global Constraints

- No comprehension quizzes or formal checks between lesson blocks — the learner just confirms readiness ("listo"/"siguiente") to advance.
- No persistent progress-tracking state in the Worker — lesson progress is inferred entirely from the `history` array already sent with every chat request.
- No second content file (e.g. `teaching_kids.md`) — `teaching.md` serves both the new `teach` mode and the existing `deep_dive` mode.
- No bulk regeneration of existing games' `teaching.md` — regenerate on demand, per game, when needed.
- `buildDeepDiveContext` (`worker/src/deepDiveContext.js`) is reused unchanged — do not rename or modify it.
- The global `SYSTEM` prompt constant in `scripts/compiler/llm_compiler.py` (English, for `index`/`setup`/`rules`/`faq`/`glossary`) is not touched — only the `"teaching"` entry in `_prompts()` changes to force Spanish.

---

### Task 1: Rewrite the `teaching` section generation prompt (Spanish, learner-facing blocks)

**Files:**
- Modify: `scripts/compiler/llm_compiler.py:82-91`
- Test: `tests/compiler/test_llm_compiler.py`

**Interfaces:**
- Consumes: nothing new — uses the existing `_prompts(game_data, rulebook_text)` function signature and the existing `ex`/`rb`/`name` local variables already computed in that function (line 41-44).
- Produces: `_prompts(...)["teaching"]` — a string still consumed the same way by `compile_game()` (line 296-299, unchanged). No other task depends on the exact wording, only that it's still a string keyed `"teaching"`.

- [ ] **Step 1: Write the failing test**

Add to `tests/compiler/test_llm_compiler.py` (near the other `_prompts` tests, after `test_base_game_prompts_have_no_expansion_block` at line 149):

```python
def test_teaching_prompt_targets_spanish_speaking_beginner():
    from compiler.llm_compiler import _prompts
    prompts = _prompts(GAME_DATA, rulebook_text=None)
    teaching_prompt = prompts["teaching"]

    assert "entirely in Spanish" in teaching_prompt
    assert "beginner" in teaching_prompt.lower()
    assert "jerga" in teaching_prompt
    assert "Orden de enseñanza" in teaching_prompt
    assert "Suggested teaching order" not in teaching_prompt
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/test_llm_compiler.py::test_teaching_prompt_targets_spanish_speaking_beginner -v`
Expected: FAIL — `assert "entirely in Spanish" in teaching_prompt` fails because the current prompt is in English and says "Suggested teaching order".

- [ ] **Step 3: Replace the `teaching` prompt**

In `scripts/compiler/llm_compiler.py`, replace lines 82-91 (the `"teaching": (...)` entry inside the dict returned by `_prompts`):

```python
        "teaching": (
            f"{ex}Write a teaching guide for \"{name}\", entirely in Spanish, addressed directly "
            "to a beginner learning the game for the first time (a child or an adult with no "
            "board-gaming experience) — as if you were sitting next to them explaining it. "
            "Use simple, warm, second-person language ('vos vas a...', 'ahora te toca...'). "
            "Never use board-gaming jargon (worker placement, engine building, etc.) without "
            "explaining it in plain words the first time it appears. Keep sentences short.\n"
            f"{rb}\n"
            "Include these sections, in this order:\n"
            "1. **Explicación de 5 minutos** — de qué se trata el juego, en el lenguaje más simple posible\n"
            "2. **Orden de enseñanza** — una lista numerada de temas a explicar, uno a la vez; cada ítem "
            "debe ser un párrafo corto y autocontenido, listo para leérselo o parafraseárselo al aprendiz "
            "directamente (no una instrucción meta como 'explicar que...', sino la explicación en sí)\n"
            "3. **Primera ronda paso a paso** — narra un primer turno típico en segunda persona, como si "
            "el aprendiz lo estuviera jugando en este momento\n"
            "4. **Reglas para más adelante** — reglas menores a mencionar solo si surgen naturalmente, no "
            "de entrada (esto es para que quien lidera la partida sepa qué callarse al principio)\n"
            "5. **Errores comunes de principiante** — en lenguaje simple, qué suelen hacer mal\n"
            "6. **Detalles que se olvidan** — reglas que hasta jugadores con experiencia pasan por alto"
        ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && pytest tests/compiler/test_llm_compiler.py -v`
Expected: PASS — all tests in the file pass, including the new one. This also confirms the pre-existing tests (`test_compile_game_returns_six_sections`, `test_all_prompts_include_expansion_block`, etc.) still pass, since the section key (`"teaching"`) and the `{ex}`/`{rb}` interpolation points are unchanged.

- [ ] **Step 5: Commit**

```bash
cd /home/carlos-ardila/Documents/gitprojects/mybgg
git add scripts/compiler/llm_compiler.py tests/compiler/test_llm_compiler.py
git commit -m "$(cat <<'EOF'
feat: generate teaching.md in Spanish, addressed directly to a beginner

Replaces the English "notes for the instructor" framing with blocks
the chat's new guided-teaching mode can read straight to a learner.
EOF
)"
```

---

### Task 2: Add `teach` mode to the Worker (`SYSTEM_PROMPTS.teach` + request routing)

**Files:**
- Modify: `worker/src/index.js:60-61` (insert `teach` into `SYSTEM_PROMPTS`)
- Modify: `worker/src/index.js:518-556` (merge `deep_dive`/`teach` routing branch)
- Modify: `worker/src/index.js:592` (export `handleChat` for testing)
- Test: `worker/test/teachMode.test.js` (new file)

**Interfaces:**
- Consumes: `buildDeepDiveContext({ base, expansions, promptFn })` from `worker/src/deepDiveContext.js` (unchanged, already used by `deep_dive`) — `promptFn` is `(gameName: string) => string`.
- Produces: `handleChat(request: Request, env) => Promise<Response>` now exported from `worker/src/index.js` for tests. `SYSTEM_PROMPTS.teach` follows the same shape as `SYSTEM_PROMPTS.deep_dive`: `{ es: (gameName) => string, en: (gameName) => string }`.

- [ ] **Step 1: Write the failing test**

Create `worker/test/teachMode.test.js`:

```javascript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleChat } from '../src/index.js';
import { fakeSSEResponse, readAllText } from './sseHelpers.js';

function createFakeWiki(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

function createEnv(wikiSeed) {
  return {
    WIKI: createFakeWiki(wikiSeed),
    DEEPSEEK_API_KEY: 'key123',
    GEMINI_API_KEY: 'test-gemini-key',
    BGG_TOKEN: 'bgg-token',
  };
}

function fakeChatRequest(body) {
  return new Request('https://example.com/api/chat', {
    method: 'POST',
    headers: { Origin: 'https://bgg.cardila.com', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const wikiSeed = {
  'games/pandemic-2008/index': '---\nname: "Pandemic"\nedition: "2008"\n---\nOverview.',
  'games/pandemic-2008/rules': 'Rules text.',
  'games/pandemic-2008/teaching': 'Explicación de 5 minutos de prueba.',
  'games/pandemic-2008/faq': 'FAQ text.',
  'games/pandemic-2008/glossary': 'Glossary text.',
};

const noToolCallSSE = () =>
  fakeSSEResponse([
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hola' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]);

describe('handleChat mode="teach"', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects the teach system prompt and includes the teaching guide in context', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const request = fakeChatRequest({
      message: 'Enséñame a jugar Pandemic desde cero.',
      history: [],
      mode: 'teach',
      game: 'pandemic-2008',
      expansions: [],
      language: 'es',
    });

    const response = await handleChat(request, createEnv(wikiSeed));
    await readAllText(response);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMessage = requestBody.messages.find((m) => m.role === 'system');
    expect(systemMessage.content).toContain('tutor paciente');
    expect(systemMessage.content).toContain('PROACTIVA');
    expect(systemMessage.content).not.toContain('Eres un experto en');
    expect(systemMessage.content).toContain('Explicación de 5 minutos de prueba.');
  });

  it('still selects the deep_dive system prompt when mode is "deep_dive" (regression)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const request = fakeChatRequest({
      message: '¿Cómo se anota la ciudad?',
      history: [],
      mode: 'deep_dive',
      game: 'pandemic-2008',
      expansions: [],
      language: 'es',
    });

    const response = await handleChat(request, createEnv(wikiSeed));
    await readAllText(response);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMessage = requestBody.messages.find((m) => m.role === 'system');
    expect(systemMessage.content).toContain('Eres un experto en');
    expect(systemMessage.content).not.toContain('tutor paciente');
  });

  it('returns an error when mode is "teach" but no game slug is given', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const request = fakeChatRequest({ message: 'hola', history: [], mode: 'teach', game: null });
    const response = await handleChat(request, createEnv({}));
    const text = await readAllText(response);

    expect(text).toContain('Invalid mode');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg/worker && npx vitest run test/teachMode.test.js`
Expected: FAIL — `handleChat` is not exported from `../src/index.js` yet (import resolves to `undefined`, calling it throws `handleChat is not a function`).

- [ ] **Step 3: Add `SYSTEM_PROMPTS.teach`**

In `worker/src/index.js`, insert a new `teach` key between the end of `deep_dive` (line 60, `  },`) and the closing `};` of `SYSTEM_PROMPTS` (line 61):

```javascript
  teach: {
    es: (gameName) =>
      `Eres un tutor paciente enseñándole ${gameName} a alguien que nunca lo ha jugado — puede ser un niño o un adulto sin experiencia en juegos de mesa. Tienes acceso a la guía de enseñanza del juego (ya escrita en español, en bloques, para principiantes) junto con reglas, FAQ y glosario como referencia si el aprendiz pregunta algo puntual.
Guía la lección de forma PROACTIVA, no esperes a que pregunten:
1. Empezá con la "Explicación de 5 minutos" como bienvenida.
2. Luego recorré el "Orden de enseñanza" un ítem a la vez. Después de cada ítem, preguntá si está listo/a para seguir o si tiene dudas — no avances al siguiente ítem hasta que el aprendiz lo confirme (por ejemplo "listo", "dale", "sí", o similar).
3. Cuando termines el orden de enseñanza, contá la "Primera ronda paso a paso" como si estuviera pasando ahora mismo.
4. Cerrá con los "Errores comunes de principiante" antes de que empiecen a jugar de verdad.
5. Las "Reglas para más adelante" NO las menciones de entrada — solo si el aprendiz pregunta algo directamente relacionado.
Si en cualquier momento te preguntan algo fuera de la secuencia, respondé la duda puntual (usando reglas/FAQ/glosario si hace falta) y después retomá donde ibas.
Usá lenguaje simple y cálido, en segunda persona, sin jerga de juegos de mesa sin explicarla la primera vez.
IMPORTANTE: Solo respondé sobre ${gameName} y juegos de mesa en general. Si preguntan otra cosa, redirigí amablemente la conversación.`,
    en: (gameName) =>
      `You are a patient tutor teaching ${gameName} to someone who has never played it — a child or an adult with no board-gaming experience. You have access to the game's teaching guide (already written for beginners) plus rules, FAQ, and glossary as reference if the learner asks something specific.
Guide the lesson PROACTIVELY, don't wait to be asked:
1. Start with the "5-minute explanation" as a welcome.
2. Walk through the "teaching order" one item at a time. After each item, ask if they're ready to move on or have questions — don't advance until the learner confirms (e.g. "ready", "yes", "go on").
3. Once you finish the teaching order, narrate the "first round walkthrough" as if it's happening right now.
4. Close with "common beginner mistakes" before they start playing for real.
5. Don't bring up "rules for later" unprompted — only if the learner asks something directly related.
If asked something out of sequence at any point, answer it (using rules/FAQ/glossary if needed) and then resume where you left off.
Use simple, warm, second-person language, without unexplained board-gaming jargon.
IMPORTANT: Only answer about ${gameName} and board games in general. If asked about anything else, kindly redirect the conversation.`,
  },
```

- [ ] **Step 4: Merge the `deep_dive`/`teach` request-handling branch**

In `worker/src/index.js`, replace lines 518-556 (from `} else if (mode === 'deep_dive' && game) {` through the closing `}` before `const cappedHistory`):

```javascript
  } else if ((mode === 'deep_dive' || mode === 'teach') && game) {
    if (!/^[a-z0-9-]+$/.test(game)) {
      return sseError(request, 'Invalid game slug.');
    }
    if (!Array.isArray(expansions) || expansions.length > 10) {
      return sseError(request, 'Invalid expansions list.');
    }
    if (!expansions.every((slug) => /^[a-z0-9-]+$/.test(slug))) {
      return sseError(request, 'Invalid expansion slug.');
    }

    const sectionNames = ['index', 'rules', 'teaching', 'faq', 'glossary'];
    const slugs = [game, ...expansions];
    const fetched = await Promise.all(
      slugs.flatMap((slug) =>
        sectionNames.map((section) => env.WIKI.get(`games/${slug}/${section}`))
      )
    );
    const entries = slugs.map((slug, i) => {
      const offset = i * sectionNames.length;
      return {
        slug,
        index: fetched[offset],
        rules: fetched[offset + 1],
        teaching: fetched[offset + 2],
        faq: fetched[offset + 3],
        glossary: fetched[offset + 4],
      };
    });

    const promptFn = SYSTEM_PROMPTS[mode][language] ?? SYSTEM_PROMPTS[mode].es;
    systemContent = buildDeepDiveContext({
      base: entries[0],
      expansions: entries.slice(1),
      promptFn,
    });
  } else {
    return sseError(request, 'Invalid mode. Use "discovery", "deep_dive", or "teach" with a game slug.');
  }
```

- [ ] **Step 5: Export `handleChat`**

In `worker/src/index.js`, replace the export line (line 592):

```javascript
export { callDeepSeek, parseDeepSeekStream, streamDeepSeek, runChatCompletion, statusForToolCalls, minimizeGame, parseCatalog, handleChat };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg/worker && npx vitest run test/teachMode.test.js`
Expected: PASS — all 3 tests pass.

- [ ] **Step 7: Run the full Worker test suite to check for regressions**

Run: `cd /home/carlos-ardila/Documents/gitprojects/mybgg/worker && npm test`
Expected: PASS — all existing suites (`deepDiveContext.test.js`, `runChatCompletion.test.js`, `minimizeGame.test.js`, etc.) still pass unchanged, confirming the `deep_dive` branch behaves identically to before the merge.

- [ ] **Step 8: Commit**

```bash
cd /home/carlos-ardila/Documents/gitprojects/mybgg
git add worker/src/index.js worker/test/teachMode.test.js
git commit -m "$(cat <<'EOF'
feat: add "teach" chat mode for guided, block-by-block lessons

Reuses the deep_dive context builder and KV fetch — only the system
prompt differs. No new backend state: lesson progress is inferred
from the conversation history already sent with every request.
EOF
)"
```

---

### Task 3: Add the "Enséñame a jugar" button to `chat.html`

**Files:**
- Modify: `chat.html:205` (add second button next to "Empezar")
- Modify: `chat.html:463-479` (`startDeepDive`, unchanged, used as the model for the new function)
- Modify: `chat.html:481-519` (game-select change listener — show/hide both buttons)
- Modify: `chat.html:521-534` (add a click listener for the new button; existing `btn-start-deepdive` listener unchanged)
- Modify: `chat.html:536-551` (`resetToDiscovery` — hide the new button too)

**Interfaces:**
- Consumes: `sendMessage(userText: string)` (chat.html:348, unchanged) and `setAwaitingCombo(awaiting: boolean)` (chat.html:454, unchanged).
- Produces: `startTeach(baseSlug, baseLabel, expansionSlugs, expansionLabels)` — same signature as `startDeepDive`, no other file depends on it (chat.html is not imported anywhere).

**Note on testing:** `chat.html` has no automated test harness in this repo (no frontend test files exist anywhere in the codebase). This task is verified manually in a browser instead of with an automated test — consistent with how the rest of `chat.html` is verified today.

- [ ] **Step 1: Add the second button**

In `chat.html`, replace line 205:

```html
  <button id="btn-start-deepdive" style="display:none">Empezar</button>
  <button id="btn-start-teach" style="display:none">Enséñame a jugar</button>
```

- [ ] **Step 2: Add the `startTeach` function**

In `chat.html`, insert immediately after the closing `}` of `startDeepDive` (after line 479, before the blank line preceding `document.getElementById('game-select').addEventListener`):

```javascript
  function startTeach(baseSlug, baseLabel, expansionSlugs, expansionLabels) {
    currentMode = 'teach';
    currentGame = baseSlug;
    currentExpansions = expansionSlugs;
    currentGameName = [baseLabel, ...expansionLabels].join(' + ');
    history = [];
    setAwaitingCombo(false);

    const safeName = currentGameName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    document.getElementById('mode-bar').textContent = `Modo: Aprendiendo ${currentGameName}`;
    document.getElementById('btn-reset-discovery').style.display = 'inline';
    document.getElementById('chat-container').innerHTML = '';

    sendMessage(currentLanguage === 'en'
      ? `Teach me how to play ${safeName} from scratch.`
      : `Enséñame a jugar ${safeName} desde cero.`);
  }
```

- [ ] **Step 3: Show/hide both buttons together in the game-select listener**

In `chat.html`, replace the `game-select` change listener (lines 481-519):

```javascript
  document.getElementById('game-select').addEventListener('change', function () {
    const slug = this.value;
    const checkboxContainer = document.getElementById('expansion-checkboxes');
    const startButton = document.getElementById('btn-start-deepdive');
    const teachButton = document.getElementById('btn-start-teach');
    checkboxContainer.innerHTML = '';

    if (!slug) {
      checkboxContainer.style.display = 'none';
      startButton.style.display = 'none';
      teachButton.style.display = 'none';
      setAwaitingCombo(false);
      return;
    }

    const game = allGames.find((g) => g.slug === slug);
    const label = this.options[this.selectedIndex].textContent;
    const expansions = (game && game.expansions) || [];

    if (expansions.length === 0) {
      checkboxContainer.style.display = 'none';
      startButton.style.display = 'inline';
      teachButton.style.display = 'inline';
      setAwaitingCombo(true);
      return;
    }

    expansions.forEach((exp) => {
      const wrapper = document.createElement('label');
      wrapper.className = 'expansion-checkbox';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = exp.slug;
      input.dataset.label = gameLabel(exp);
      wrapper.appendChild(input);
      wrapper.appendChild(document.createTextNode(' ' + gameLabel(exp)));
      checkboxContainer.appendChild(wrapper);
    });
    checkboxContainer.style.display = 'block';
    startButton.style.display = 'inline';
    teachButton.style.display = 'inline';
    setAwaitingCombo(true);
  });
```

This also fixes a gap: today, games with no expansions skip straight into `deep_dive` on selection (line 501, `startDeepDive(slug, label, [], [])`), bypassing any button click. Left as-is, the new "Enséñame a jugar" button would be unreachable for every game without expansions (the majority of the collection). Now both buttons show and wait for an explicit click for every game, with or without expansions.

- [ ] **Step 4: Add the click listener for the new button**

In `chat.html`, immediately after the existing `btn-start-deepdive` click listener (after line 534, its closing `});`), add:

```javascript
  document.getElementById('btn-start-teach').addEventListener('click', function () {
    const select = document.getElementById('game-select');
    const slug = select.value;
    if (!slug) return;
    const label = select.options[select.selectedIndex].textContent;

    const checked = Array.from(
      document.querySelectorAll('#expansion-checkboxes input[type="checkbox"]:checked')
    );
    const expansionSlugs = checked.map((c) => c.value);
    const expansionLabels = checked.map((c) => c.dataset.label);

    startTeach(slug, label, expansionSlugs, expansionLabels);
  });
```

- [ ] **Step 5: Hide the new button in `resetToDiscovery`**

In `chat.html`, in `resetToDiscovery` (lines 536-551), add one line after `document.getElementById('btn-start-deepdive').style.display = 'none';`:

```javascript
    document.getElementById('btn-start-deepdive').style.display = 'none';
    document.getElementById('btn-start-teach').style.display = 'none';
```

- [ ] **Step 6: Manual verification against a local Worker**

The Worker's CORS check (`worker/src/index.js` `getCorsHeaders`) allows any `http://localhost` origin, so this can be tested fully locally:

1. Start the Worker: `cd /home/carlos-ardila/Documents/gitprojects/mybgg/worker && wrangler dev` (uses `worker/.dev.vars` for API keys — confirm that file has real `DEEPSEEK_API_KEY`/`GEMINI_API_KEY`/`BGG_TOKEN` values before running; this makes real, billed LLM calls). Note the local URL it prints (typically `http://localhost:8787`).
2. Temporarily edit `chat.html` line 221 to point at it: `const WORKER_URL = 'http://localhost:8787';`
3. In a second terminal, serve the static file: `cd /home/carlos-ardila/Documents/gitprojects/mybgg && python -m http.server 8000`
4. Open `http://localhost:8000/chat.html` in a browser.
5. Select a game from the dropdown (pick one with a non-empty `teaching.md`, e.g. `carcassonne-traders-builders-2003` if present in local KV, or any game already synced). Confirm **both** "Empezar" and "Enséñame a jugar" appear (for a game with no expansions too — confirms Step 3's fix).
6. Click "Enséñame a jugar". Confirm: the mode bar reads "Modo: Aprendiendo <juego>", the chat clears, a user bubble with "Enséñame a jugar ... desde cero." appears, and the assistant's first reply is a proactive welcome + 5-minute explanation (not a "ready for your questions" Q&A opener).
7. Reply "listo" and confirm the assistant advances to the next item of the teaching order rather than repeating itself or dumping everything at once.
8. Revert `chat.html` line 221 back to `const WORKER_URL = '';` before committing — it must not ship pointed at localhost.

- [ ] **Step 7: Commit**

```bash
cd /home/carlos-ardila/Documents/gitprojects/mybgg
git add chat.html
git commit -m "$(cat <<'EOF'
feat: add "Enséñame a jugar" button for guided teaching mode

Also fixes games with no expansions skipping straight into deep_dive
on selection — both buttons now always wait for an explicit click, so
the new teach mode is reachable for every game, not just ones with
expansions.
EOF
)"
```

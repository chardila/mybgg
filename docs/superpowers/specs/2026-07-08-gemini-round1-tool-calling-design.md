# Diseño: Gemini 2.5 Flash-Lite para Round 1 de tool-calling

**Fecha:** 2026-07-08  
**Estado:** Aprobado

## Problema

DeepSeek V4 Flash tiene un bug no resuelto donde el mecanismo de tool-calling filtra markup interno DSML como texto plano (`finish_reason: "stop"` en lugar de `"tool_calls"`). El comportamiento es no-determinístico y ha requerido 3-4 reintentos por pregunta en uso real, haciendo el chat inutilizable.

La mitigación actual (retry + fallback message) no es suficiente: el bug aparece con demasiada frecuencia.

## Solución

Reemplazar DeepSeek con **Gemini 2.5 Flash-Lite** exclusivamente en **Round 1** (la ronda donde el modelo decide si llamar herramientas BGG). Round 2 (síntesis de la respuesta) se mantiene en DeepSeek.

## Arquitectura

```
Antes:
  Round 1: DeepSeek (tools) → ⚠️ bug DSML → retry → fallback
  Round 2: DeepSeek (sin tools) → retry por si acaso

Después:
  Round 1: Gemini 2.5 Flash-Lite (tools) → ✅ sin bug, sin retry
  Round 2: DeepSeek V4 Flash (sin tools) → llamada simple, sin retry
```

La ejecución de herramientas BGG entre las dos rondas no cambia.

## Justificación de modelo

| Modelo | Input $/M | Output $/M | Costo Round 1 | Delta vs hoy |
|--------|-----------|------------|---------------|--------------|
| DeepSeek V4 Flash (actual) | $0.14 | $0.28 | ~$0.00050 | — |
| **Gemini 2.5 Flash-Lite** | $0.10 | $0.40 | ~$0.00042 | **-5%** |
| GPT-4o-mini | $0.15 | $0.60 | ~$0.00063 | +8% |

Gemini 2.5 Flash-Lite es la opción más barata y tiene tool-calling confiable y maduro. El free tier (1.000 req/día, 15 RPM) es más que suficiente para uso personal.

Gemini expone un endpoint compatible con OpenAI en `/v1beta/openai/chat/completions`, con el mismo formato SSE, mismos `choices[0].delta`, y mismos valores de `finish_reason`. El parser SSE existente (`parseDeepSeekStream`, en `worker/src/index.js`) debería funcionar sin cambios — verificar durante implementación que el formato de `delta.tool_calls` en streaming sea idéntico al de OpenAI/DeepSeek.

> **Nota de implementación:** confirmar el model ID exacto de Gemini en el endpoint OpenAI-compatible (puede ser `gemini-2.5-flash-lite` o incluir un sufijo de versión como `-preview-06-17`). Consultar la documentación de Google AI en el momento de implementar.

## Cambios en `worker/src/index.js`

### Agregar `callGemini`

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

### Refactorizar `attemptBufferedRound` a genérico

```javascript
// Antes: acoplado a callDeepSeek
async function attemptBufferedRound(messages, env, tools) { ... }

// Después: acepta cualquier función que devuelva un Response SSE
async function attemptBufferedRound(messages, callFn) {
  const bufferedTokens = [];
  const response = await callFn(messages);
  const result = await parseDeepSeekStream(response, async (token) => {
    bufferedTokens.push(token);
  });
  return { ...result, bufferedTokens };
}
```

### `runChatCompletion` actualizado

```javascript
async function runChatCompletion(messages, env, request, language = 'es') {
  // Round 1: Gemini decide si llamar tools (sin bug DSML, sin retry)
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
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* sin args */ }
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
    { role: 'assistant', content: null, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: tc.function })) },
    ...toolMessages,
  ];

  // Round 2: DeepSeek sintetiza (sin tools, DSML no aplica)
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

### Código eliminado

- `bufferedRoundWithLeakRetry` — ya no necesaria
- `looksLikeLeakedToolCall` — ya no necesaria
- `fallbackMessage` — ya no necesaria

Neto: ~30 líneas eliminadas, ~15 agregadas. El archivo queda más simple.

## Cambios en tests (`worker/test/runChatCompletion.test.js`)

- Mockar `callGemini` para Round 1 con el mismo formato SSE que el mock actual de `callDeepSeek`
- Eliminar los ~4 tests de escenarios DSML leak (retry, doble leak, fallback)
- Agregar `GEMINI_API_KEY: 'test-gemini-key'` al objeto `env` de cada test

## Secrets

**Local** — agregar a `.dev.vars`:
```
GEMINI_API_KEY=AIza...
```

**Producción:**
```bash
wrangler secret put GEMINI_API_KEY
```

No hay cambios en `wrangler.toml`.

## Archivos que cambian

| Archivo | Tipo de cambio |
|---------|----------------|
| `worker/src/index.js` | Agregar `callGemini`, refactorizar `attemptBufferedRound`, actualizar `runChatCompletion`, eliminar DSML helpers |
| `worker/test/runChatCompletion.test.js` | Actualizar mocks, eliminar tests DSML |
| `.dev.vars` | Agregar `GEMINI_API_KEY` |

## Lo que NO cambia

- `worker/src/bggTools.js` — definiciones y ejecución de herramientas BGG
- `parseDeepSeekStream` en `worker/src/index.js` — parser SSE reutilizado sin cambios
- `chat.html` — cliente sin cambios
- `wrangler.toml` — configuración sin cambios
- Lógica de rate limiting
- Sistema de prompts (discovery / deep dive)

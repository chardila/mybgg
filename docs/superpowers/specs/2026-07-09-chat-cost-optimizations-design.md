# Diseño: Optimizaciones de costo del chat (Gemini + DeepSeek)

**Fecha:** 2026-07-09
**Estado:** Aprobado

## Contexto

`analisis_arquitectura_chat.md` (Antigravity, 2026-07-08) analizó costos y arquitectura del chat y propuso mantener el modelo híbrido Gemini (tool-calling) + DeepSeek (síntesis), más 3 tareas concretas de optimización.

Validación contra el código real y producción antes de planear:

- **La arquitectura híbrida ya está implementada.** `runChatCompletionStream` (`worker/src/index.js:315`) ya usa Gemini para hasta `MAX_TOOL_ROUNDS=2` rondas de tool-calling y delega la síntesis final a DeepSeek solo cuando se llamaron herramientas; si Gemini responde directo, DeepSeek nunca se invoca. No requiere cambios.
- **Los nombres de campo del catálogo en la Tarea 2 del documento (`source`, `pdf_url`, `imported`, `bgg_rank`) no existen.** Verificado con `curl https://bgg.cardila.com/api/games` contra el catálogo real de producción (14 juegos, ~9KB). El schema real es: `slug, name, players, weight, playing_time, mechanics, categories, edition, status, rank, base_game_slug, expansions`.
- **El modelo de Gemini 3.1 Flash-Lite existe y su model ID/endpoint/pricing están confirmados** (`gemini-3.1-flash-lite`, mismo endpoint OpenAI-compat, $0.25/$1.50 por 1M tokens). Tiene thinking levels (minimal/low/medium/high) que **por defecto usan "high"** — sin fijarlo explícitamente, la migración agregaría tokens de razonamiento facturados como output en cada ronda de tool-calling.
- **El regex de limpieza de citas de la Tarea 3 del documento es incompleto.** BGG soporta `[q]`/`[/q]` (sintaxis nativa) además de `[quote]`/`[/quote]` (sinónimo agregado después), ambos con o sin atribución. El regex propuesto en el documento solo cubre `[quote=...]` con atribución.

## Tarea 1 — Migrar Gemini a `gemini-3.1-flash-lite`

### Cambio en `callGemini` (`worker/src/index.js:101`)

```javascript
async function callGemini(messages, apiKey, { tools } = {}) {
  const body = {
    model: 'gemini-3.1-flash-lite',
    messages,
    stream: true,
    reasoning_effort: 'minimal',
  };
  if (tools) body.tools = tools;
  // resto sin cambios
}
```

`reasoning_effort: 'minimal'` porque el rol de Gemini aquí es tool-calling/routing determinista sobre un schema fijo (`BGG_TOOL_DEFINITIONS`), no razonamiento — minimizar latencia y costo de output es la prioridad.

### Validación

- Correr la suite existente (`worker/test/runChatCompletion.test.js`, `deepseekStream.test.js`).
- Probar manualmente con `wrangler dev` al menos un flujo con tool-calling real (ej. "¿qué expansiones tiene X?") para confirmar que `finish_reason: tool_calls` se sigue disparando igual que con `gemini-2.5-flash-lite`.

### Fuera de alcance

No tocar `MAX_TOOL_CALLS_PER_ROUND` / `MAX_TOOL_ROUNDS`, ni el manejo de retry/fallback existente (`attemptBufferedRoundWithRetry`, `isIncompleteStream`) — el cambio es aislado al body de la petición a Gemini.

## Tarea 2 — Minimizar catálogo para el system prompt (solo `handleChat`)

### Nueva función `minimizeGame` en `worker/src/index.js`

```javascript
function minimizeGame(game, isNested = false) {
  const out = {
    name: game.name,
    players: game.players,
    weight: game.weight,
    mechanics: game.mechanics,
    categories: game.categories,
    status: game.status,
  };
  if (!isNested) {
    out.rank = game.rank;
    if (game.expansions?.length) {
      out.expansions = game.expansions.map((e) => minimizeGame(e, true));
    }
  }
  return out;
}
```

Se descartan: `slug`, `base_game_slug`, `edition`, `playing_time` (vacío en el 100% de las entradas de producción). En expansiones anidadas también se descartan `rank` y `expansions` recursivo — evita duplicar el árbol completo dos veces (cada expansión ya existe también como entrada de nivel superior con todos sus campos). El prompt de discovery (`SYSTEM_PROMPTS.discovery`) ya pide sugerir expansiones por nombre, no por slug, así que `name` alcanza.

Reducción medida contra el catálogo real de producción: **~41%** (8906 → 5214 bytes en JSON compacto).

### Dónde se aplica (`handleChat`, rama `discovery`, línea ~474)

```javascript
const catalogRaw = (await env.WIKI.get('catalog')) || '[]';
const minimized = JSON.parse(catalogRaw).map((g) => minimizeGame(g));
systemContent = `${systemBase}\n\nUser's game catalog (JSON):\n${JSON.stringify(minimized)}`;
```

### Lo que NO cambia

`handleGetGames` (`worker/src/index.js:401`) sigue devolviendo `env.WIKI.get('catalog')` crudo, sin minimizar. `chat.html` depende de `slug`, `base_game_slug` y `expansions[].slug` (líneas 332, 494-510) para poblar el selector de juego/expansión y para armar el request de `deep_dive` (`/api/chat` con `game` y `expansions` por slug) — minimizar esa respuesta rompería el selector.

### Fuera de alcance

Cacheo en KV del catálogo minimizado — el catálogo actual (~9KB) no lo justifica. Si el catálogo crece significativamente en el futuro, reevaluar.

### Testing

Test unitario para `minimizeGame`: campos correctos, no duplica el árbol de expansiones anidadas, maneja catálogo vacío (`[]`). Verificación manual de que `/api/games` sigue devolviendo el JSON completo sin cambios.

## Tarea 3 — Limpiar y truncar hilos de foro (`bggTools.js`)

### Cambio en `getThread()` (`worker/src/bggTools.js:174`)

```javascript
const MAX_THREAD_POSTS = 10;
const MAX_POST_CHARS = 1500;

function stripQuotes(text) {
  // BGG soporta [q]/[/q] (nativo) y [quote]/[/quote] (sinónimo agregado después),
  // ambos con o sin atribución (ej. [q=usuario], [quote=usuario]).
  return text.replace(/\[(?:q|quote)(?:=[^\]]*)?\]([\s\S]*?)\[\/(?:q|quote)\]/gi, '').trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function getThread({ thread_id }, token) {
  const data = await bggFetch('/thread', { id: thread_id }, token);
  const thread = data.thread;
  if (!thread || !thread.subject) throw new Error(`Thread ${thread_id} not found`);
  const articles = asArray(thread.articles?.article);
  return {
    id: Number(thread['@_id']),
    subject: thread.subject,
    posts: articles.slice(0, MAX_THREAD_POSTS).map((article) => ({
      author: article['@_username'],
      date: article['@_postdate'],
      text: truncate(stripQuotes(typeof article.body === 'string' ? article.body : ''), MAX_POST_CHARS),
    })),
  };
}
```

### Notas de diseño

- El regex remueve el bloque de cita completo (etiqueta + contenido citado), no solo las etiquetas — el contenido citado ya apareció en el post original que se está citando.
- No maneja citas anidadas perfectamente (el no-greedy corta en el primer cierre que encuentra, pudiendo dejar un tag de cierre suelto en casos anidados). Es un caso límite raro en foros de BGG; el resultado sigue siendo estrictamente mejor que el body sin filtrar. No se justifica un parser de tags más complejo para este caso.
- `slice(0, 10)` se aplica antes de truncar cada post — prioriza cantidad de posts distintos sobre profundidad de posts individuales muy largos.
- Igual que el código actual, si `article.body` no es string, cae a `''`.

### Testing

Tests unitarios en `worker/test/bggTools.test.js`: cita con atribución (`[quote=user]...[/quote]`), cita `[q]` sin atribución, post sin citas, post >1500 caracteres, thread con >10 posts. Como la API real de BGG requiere token/auth y no está disponible en el entorno de test, estos tests deben mockear `bggFetch` o construir el XML/objeto parseado de fixture directamente (mismo patrón que el resto de `bggTools.test.js`).

## Archivos que cambian

| Archivo | Tipo de cambio |
|---------|----------------|
| `worker/src/index.js` | `callGemini`: agregar `reasoning_effort` y actualizar model id. Nueva función `minimizeGame`. Aplicar minimización en `handleChat` (rama discovery). |
| `worker/src/bggTools.js` | `getThread`: agregar `stripQuotes`, `truncate`, límite de posts. |
| `worker/test/runChatCompletion.test.js` | Verificar/actualizar mocks si el cambio de modelo afecta algún assert existente. |
| `worker/test/bggTools.test.js` | Nuevos tests para limpieza/truncado/límite de `getThread`. |
| Nuevo archivo o sección de test para `minimizeGame` | Tests unitarios de la función. |

## Lo que NO cambia

- Arquitectura híbrida Gemini/DeepSeek (`runChatCompletionStream`) — ya implementada, sin cambios.
- `handleGetGames` — sigue devolviendo el catálogo completo sin minimizar.
- `chat.html` — cliente sin cambios.
- `wrangler.toml`, secrets — sin cambios (no se agregan nuevas API keys).
- `MAX_TOOL_ROUNDS`, `MAX_TOOL_CALLS_PER_ROUND`, lógica de retry/fallback (`attemptBufferedRoundWithRetry`, `isIncompleteStream`, `looksLikeLeakedToolCall`, `noMoreToolsNote`).
- `bgg_search_game`, `bgg_get_game_details`, `bgg_search_forum` — sin cambios, solo `getThread`.

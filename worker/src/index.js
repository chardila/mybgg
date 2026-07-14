import { buildDeepDiveContext } from './deepDiveContext.js';
import { checkRateLimit } from './rateLimiter.js';
import { BGG_TOOL_DEFINITIONS, executeBggTool } from './bggTools.js';

const MAX_TOOL_CALLS_PER_ROUND = 3;
const MAX_TOOL_ROUNDS = 2;

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const isAllowed =
    origin === 'https://bgg.cardila.com' || /^http:\/\/localhost/.test(origin);
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://bgg.cardila.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const SYSTEM_PROMPTS = {
  discovery: {
    es: `Eres un asistente experto en juegos de mesa. Ayudas al usuario a decidir qué jugar en su noche de juegos.
Tienes acceso al catálogo de juegos del usuario. Responde en español.
Algunas entradas del catálogo incluyen un campo "expansions" con las expansiones que el usuario posee de ese juego. Tenlas en cuenta activamente: si lo que pide el usuario (más jugadores de los que soporta el juego base, más profundidad estratégica, un tema o mecánica distinta) se resuelve mejor agregando una o varias expansiones específicas, sugiere el juego base junto con esas expansiones por nombre, en vez de limitarte al juego base.
Cada entrada del catálogo incluye "numplays": cuántas veces ya jugaste ese juego. Tenlo en cuenta como una señal más (junto con jugadores, tiempo, peso) para variar tus recomendaciones — inclínate por juegos poco jugados o nunca jugados cuando encajen igual de bien con lo que pide el usuario, pero no descartes un juego muy jugado si es claramente la mejor opción. Cuando recomiendes un juego, mencioná siempre cuántas veces ya lo jugó (por ejemplo: "nunca lo has jugado" o "lo has jugado 3 veces"). Si el usuario pregunta directamente por su historial de partidas (qué no ha jugado, qué jugó más), respondé usando este dato.
Haz preguntas concretas cuando ayude a decidir: cuántos jugadores son, cuánto tiempo tienen, si quieren algo más ligero o más desafiante. Usa las respuestas para acotar entre los juegos y expansiones disponibles.
Preserva la terminología oficial en inglés cuando no hay traducción establecida (ej: "Worker Placement", "Area Control").
Sé conciso y práctico. Cuando el usuario haya decidido qué jugar, dile que seleccione el juego base en el desplegable y marque las expansiones elegidas (si el juego tiene expansiones) para obtener ayuda detallada durante la partida.
Si la pregunta requiere información que no está en el catálogo (por ejemplo, decidir qué expansión o juego nuevo comprar), tenés herramientas para buscar en BoardGameGeek en vivo — úsalas.
IMPORTANTE: Solo responde preguntas relacionadas con juegos de mesa. Si el usuario pregunta sobre cualquier otro tema, responde amablemente que solo puedes ayudar con juegos de mesa y redirige la conversación.`,
    en: `You are a board game expert assistant. You help the user decide what to play for their game night.
You have access to the user's game catalog. Respond in English.
Some catalog entries include an "expansions" field listing the expansions the user owns for that game. Take them into account actively: if what the user wants (more players than the base game supports, more strategic depth, a different theme or mechanic) is better solved by adding one or more specific expansions, suggest the base game together with those expansions by name, rather than only ever recommending the bare base game.
Each catalog entry includes "numplays": how many times you've already played that game. Take it into account as one more signal (alongside players, time, weight) to vary your recommendations — lean toward suggesting games played little or never when they fit the request just as well, but don't rule out a heavily-played game if it's clearly the best fit. Whenever you recommend a game, always mention how many times it's been played (e.g. "you've never played this" or "you've played this 3 times"). If the user asks directly about their play history (what they haven't played, what they've played most), answer using this data.
Ask concrete questions when it helps decide: how many players, how much time they have, whether they want something lighter or more challenging. Use the answers to narrow down the available games and expansions.
Be concise and practical. Once the user has decided what to play, tell them to select the base game from the dropdown and check the expansions they chose (if the game has any) to get detailed in-game help.
If the question needs information not in the catalog (for example, deciding which expansion or new game to buy), you have tools to search BoardGameGeek live — use them.
IMPORTANT: Only answer questions related to board games. If the user asks about any other topic, kindly let them know you can only help with board games and redirect the conversation.`,
  },
  deep_dive: {
    es: (gameName) =>
      `Eres un experto en ${gameName}. Tienes acceso al wiki completo del juego incluyendo reglas, setup, guía de enseñanza, FAQ y glosario.
El contexto puede incluir el juego base junto con una o más expansiones que el usuario seleccionó. Cada sección de expansión describe solo lo que esa expansión agrega o modifica respecto al juego base, y no repite sus reglas — si la pregunta requiere combinar ambas, hazlo explícitamente y aclara qué parte viene del juego base y cuál de la expansión.
Responde en español. Preserva los nombres oficiales de componentes y mecánicas en inglés cuando no hay traducción establecida.
Si la pregunta es sobre reglas discutidas en el foro de BGG, variantes hechas por fans, o modos de un jugador no oficiales que no están en el wiki, tenés herramientas para buscar en los foros de BoardGameGeek en vivo — úsalas.
IMPORTANTE: Solo responde preguntas sobre ${gameName} y juegos de mesa en general. Si el usuario pregunta sobre cualquier otro tema, responde amablemente que solo puedes ayudar con preguntas sobre este juego y redirige la conversación.
FUENTE: Siempre indica de dónde viene tu respuesta:
- Si la información está en el wiki, comienza con "📖 Según el wiki:"
- Si la información NO está en el wiki y usas conocimiento general, comienza con "🧠 No está en el wiki — respondo con conocimiento general:"
- Si la respuesta combina ambas fuentes, usa "📖 Del wiki:" y "🧠 Conocimiento general:" para separar cada parte.`,
    en: (gameName) =>
      `You are an expert on ${gameName}. You have access to the complete game wiki including rules, setup, teaching guide, FAQ, and glossary.
The context may include the base game together with one or more expansions the user selected. Each expansion section describes only what that expansion adds or changes relative to the base game, and does not repeat its rules — if the question requires combining both, do so explicitly and make clear which part comes from the base game and which from the expansion.
Respond in English. Be precise about rules.
If the question is about rules discussed on BGG's forums, fan-made variants, or unofficial solo modes not in the wiki, you have tools to search BoardGameGeek's forums live — use them.
IMPORTANT: Only answer questions about ${gameName} and board games in general. If the user asks about any other topic, kindly let them know you can only help with questions about this game and redirect the conversation.
SOURCE: Always indicate where your answer comes from:
- If the information is in the wiki, start with "📖 From the wiki:"
- If the information is NOT in the wiki and you use general knowledge, start with "🧠 Not in the wiki — answering from general knowledge:"
- If the answer combines both, use "📖 From the wiki:" and "🧠 General knowledge:" to separate each part.`,
  },
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
};

function minimizeGame(game, isNested = false) {
  const out = {
    name: game.name,
    players: game.players,
    weight: game.weight,
    mechanics: game.mechanics,
    categories: game.categories,
    status: game.status,
    numplays: game.numplays ?? 0,
  };
  if (!isNested) {
    out.rank = game.rank;
    if (game.expansions?.length) {
      out.expansions = game.expansions.map((e) => minimizeGame(e, true));
    }
  }
  return out;
}

function parseCatalog(catalogRaw) {
  let catalog;
  try {
    catalog = JSON.parse(catalogRaw);
  } catch {
    catalog = [];
  }
  return Array.isArray(catalog) ? catalog : [];
}

function sseError(request, message, status = 200) {
  return new Response(
    `data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`,
    { status, headers: { ...getCorsHeaders(request), 'Content-Type': 'text/event-stream' } }
  );
}

function sseFormat(token) {
  return `data: ${JSON.stringify({ token })}\n\n`;
}

function sseErrorFormat(message) {
  return `data: ${JSON.stringify({ error: message })}\n\n`;
}

function sseStatusFormat(status) {
  return `data: ${JSON.stringify({ status })}\n\n`;
}

async function callDeepSeek(messages, apiKey, { tools } = {}) {
  const body = { model: 'deepseek-v4-flash', messages, stream: true };
  if (tools) body.tools = tools;

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} — ${body}`);
  }

  return response;
}

async function callGemini(messages, apiKey, { tools } = {}) {
  const body = {
    model: 'gemini-3.1-flash-lite',
    messages,
    stream: true,
    reasoning_effort: 'minimal',
  };
  if (tools) body.tools = tools;

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error: ${response.status} — ${body}`);
  }
  return response;
}

async function parseDeepSeekStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;
  const toolCallsByIndex = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        await onToken(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const key = tc.index !== undefined ? tc.index : tc.id;
          const existing = toolCallsByIndex.get(key) || {
            id: '',
            function: { name: '', arguments: '' },
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name = tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          if (tc.extra_content) existing.extra_content = tc.extra_content;
          toolCallsByIndex.set(key, existing);
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  }

  return { finishReason, toolCalls: [...toolCallsByIndex.values()] };
}

async function streamDeepSeek(messages, apiKey, request) {
  const response = await callDeepSeek(messages, apiKey, {});

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      await parseDeepSeekStream(response, async (token) => {
        await writer.write(encoder.encode(sseFormat(token)));
      });
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (e) {
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\ndata: [DONE]\n\n`)
      );
    } finally {
      writer.close();
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

async function attemptBufferedRound(messages, callFn, roundLabel) {
  const bufferedTokens = [];
  const response = await callFn(messages);
  const result = await parseDeepSeekStream(response, async (token) => {
    bufferedTokens.push(token);
  });
  if (result.finishReason !== 'stop' && result.finishReason !== 'tool_calls') {
    // Anomalous termination (e.g. hit a token cap or the upstream stream was
    // cut short) — the buffered tokens still get replayed to the user as-is,
    // but this is the one signal that tells us which case it was.
    console.error(
      `Unexpected finishReason "${result.finishReason}" in ${roundLabel} (${bufferedTokens.length} tokens buffered)`
    );
  }
  return { ...result, bufferedTokens };
}

function looksLikeLeakedToolCall(text) {
  return text.includes('DSML');
}

// A finishReason of null means the upstream stream ended without ever
// sending a finish_reason chunk — the connection was cut mid-generation
// (observed in production: e.g. a 3-token response after Gemini returned
// intermittent 503s). Distinct from finish_reason: "length" (a real token
// cap), which a retry would just reproduce.
function isIncompleteStream(result) {
  return result.finishReason === null;
}

function fallbackMessage(language) {
  return language === 'en'
    ? 'I ran into a problem answering that. Could you rephrase your question?'
    : 'Tuve un problema respondiendo eso. ¿Podés reformular la pregunta?';
}

// Retries once when shouldRetry(result) is true, then falls back (returns
// null) if the retry also matches. Used for two distinct failure modes:
// - round 1 (Gemini): stream cut short mid-generation (isIncompleteStream)
// - round 2 (DeepSeek): the DSML leak bug, plus the same incomplete-stream risk
async function attemptBufferedRoundWithRetry(messages, callFn, roundLabel, shouldRetry) {
  let result = await attemptBufferedRound(messages, callFn, roundLabel);
  if (shouldRetry(result)) {
    result = await attemptBufferedRound(messages, callFn, `${roundLabel} retry`);
    if (shouldRetry(result)) {
      console.error(`${roundLabel} failed twice in a row, falling back`);
      return null;
    }
  }
  return result;
}

async function executeToolCalls(toolCalls, env) {
  return Promise.all(
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
}

function toolCallsAssistantMessage(toolCalls) {
  return {
    role: 'assistant',
    content: null,
    // DeepSeek's thinking mode rejects a tool_calls turn in history without
    // this field, even though these tool_calls came from Gemini, not DeepSeek.
    reasoning_content: '',
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: tc.function,
      ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
    })),
  };
}

// Told to the synthesis model when MAX_TOOL_ROUNDS was used up and Gemini
// still wanted to call tools. Without this, DeepSeek tends to leak its
// attempt at requesting a tool it doesn't have as raw DSML markup instead of
// just answering with what's available.
function noMoreToolsNote(language) {
  return {
    role: 'system',
    content:
      language === 'en'
        ? "Internal note: no further BoardGameGeek lookups are available for this reply. Answer using only the information already gathered above, and if something relevant is missing, say so explicitly instead of trying to use a tool. Don't mention this note to the user."
        : 'Nota interna: ya no hay más búsquedas de BoardGameGeek disponibles para esta respuesta. Respondé solo con la información ya reunida arriba, y si falta algo relevante decilo explícitamente en vez de intentar usar una herramienta. No menciones esta nota al usuario.',
  };
}

function statusForToolCalls(toolCalls) {
  const names = new Set(toolCalls.map((tc) => tc.function.name));
  if (names.size === 1) {
    const name = [...names][0];
    if (name === 'bgg_get_game_details') return 'details';
    if (name === 'bgg_search_forum' || name === 'bgg_get_thread') return 'forum';
  }
  return 'searching';
}

async function runChatCompletionStream(messages, env, language, write) {
  let currentMessages = messages;
  let toolsWereCalled = false;
  let hitToolRoundCap = false;

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    await write(sseStatusFormat('thinking'));

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

    if (result.toolCalls.length === 0) {
      if (!toolsWereCalled) {
        for (const token of result.bufferedTokens) await write(sseFormat(token));
        return;
      }
      break;
    }

    toolsWereCalled = true;
    const toolCalls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    if (result.toolCalls.length > toolCalls.length) {
      console.warn(
        `cap-tuning: tool round ${round} requested ${result.toolCalls.length} tool calls, dropped ${result.toolCalls.length - toolCalls.length} over MAX_TOOL_CALLS_PER_ROUND=${MAX_TOOL_CALLS_PER_ROUND}`
      );
    }
    await write(sseStatusFormat(statusForToolCalls(toolCalls)));
    const toolMessages = await executeToolCalls(toolCalls, env);
    currentMessages = [...currentMessages, toolCallsAssistantMessage(toolCalls), ...toolMessages];

    if (round === MAX_TOOL_ROUNDS) {
      hitToolRoundCap = true;
      console.warn(
        `cap-tuning: all MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS} tool rounds used with tool calls still requested; synthesis proceeds without further lookups`
      );
    }
  }

  const synthesisMessages = hitToolRoundCap
    ? [...currentMessages, noMoreToolsNote(language)]
    : currentMessages;

  await write(sseStatusFormat('writing'));

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

async function handleGetGames(request, env) {
  const catalog = await env.WIKI.get('catalog');
  return new Response(catalog || '[]', {
    status: 200,
    headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
  });
}

async function handleDebugContext(request, env) {
  const url = new URL(request.url);
  const game = url.searchParams.get('game');

  const catalog = await env.WIKI.get('catalog');
  const result = { catalog_bytes: catalog ? catalog.length : 0 };

  if (game) {
    if (!/^[a-z0-9-]+$/.test(game)) {
      return new Response(JSON.stringify({ error: 'Invalid game slug' }), {
        status: 400,
        headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
      });
    }
    const [index, rules, teaching, faq, glossary] = await Promise.all([
      env.WIKI.get(`games/${game}/index`),
      env.WIKI.get(`games/${game}/rules`),
      env.WIKI.get(`games/${game}/teaching`),
      env.WIKI.get(`games/${game}/faq`),
      env.WIKI.get(`games/${game}/glossary`),
    ]);
    result.game = game;
    result.sections = {
      index: index ? index.length : null,
      rules: rules ? rules.length : null,
      teaching: teaching ? teaching.length : null,
      faq: faq ? faq.length : null,
      glossary: glossary ? glossary.length : null,
    };
    const total = [index, rules, teaching, faq, glossary]
      .filter(Boolean)
      .reduce((s, v) => s + v.length, 0);
    result.total_context_bytes = total;
    result.has_wiki = total > 0;
  }

  return new Response(JSON.stringify(result, null, 2), {
    headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
  });
}

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return sseError(request, 'Invalid JSON body');
  }

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

  if (mode === 'discovery') {
    const catalogRaw = (await env.WIKI.get('catalog')) || '[]';
    const catalog = parseCatalog(catalogRaw);
    const minimizedCatalog = catalog.map((g) => minimizeGame(g));
    const systemBase = SYSTEM_PROMPTS.discovery[language] ?? SYSTEM_PROMPTS.discovery.es;
    systemContent = `${systemBase}\n\nUser's game catalog (JSON):\n${JSON.stringify(minimizedCatalog)}`;
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

  const cappedHistory = history.slice(-20);
  const messages = [
    { role: 'system', content: systemContent },
    ...cappedHistory,
    { role: 'user', content: message },
  ];

  return runChatCompletion(messages, env, request, language);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = getCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return new Response('ok', { status: 200, headers: cors });
    }
    if (url.pathname === '/api/games' && request.method === 'GET') {
      return handleGetGames(request, env);
    }
    if (url.pathname === '/api/debug/context' && request.method === 'GET') {
      return handleDebugContext(request, env);
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }
    return new Response('not found', { status: 404, headers: cors });
  },
};

export { callDeepSeek, parseDeepSeekStream, streamDeepSeek, runChatCompletion, statusForToolCalls, minimizeGame, parseCatalog, handleChat };

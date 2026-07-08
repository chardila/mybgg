import { buildDeepDiveContext } from './deepDiveContext.js';
import { checkRateLimit } from './rateLimiter.js';
import { BGG_TOOL_DEFINITIONS, executeBggTool } from './bggTools.js';

const MAX_TOOL_CALLS_PER_ROUND = 3;

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
Haz preguntas concretas cuando ayude a decidir: cuántos jugadores son, cuánto tiempo tienen, si quieren algo más ligero o más desafiante. Usa las respuestas para acotar entre los juegos y expansiones disponibles.
Preserva la terminología oficial en inglés cuando no hay traducción establecida (ej: "Worker Placement", "Area Control").
Sé conciso y práctico. Cuando el usuario haya decidido qué jugar, dile que seleccione el juego base en el desplegable y marque las expansiones elegidas (si el juego tiene expansiones) para obtener ayuda detallada durante la partida.
Si la pregunta requiere información que no está en el catálogo (por ejemplo, decidir qué expansión o juego nuevo comprar), tenés herramientas para buscar en BoardGameGeek en vivo — úsalas.
IMPORTANTE: Solo responde preguntas relacionadas con juegos de mesa. Si el usuario pregunta sobre cualquier otro tema, responde amablemente que solo puedes ayudar con juegos de mesa y redirige la conversación.`,
    en: `You are a board game expert assistant. You help the user decide what to play for their game night.
You have access to the user's game catalog. Respond in English.
Some catalog entries include an "expansions" field listing the expansions the user owns for that game. Take them into account actively: if what the user wants (more players than the base game supports, more strategic depth, a different theme or mechanic) is better solved by adding one or more specific expansions, suggest the base game together with those expansions by name, rather than only ever recommending the bare base game.
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
};

function sseError(request, message, status = 200) {
  return new Response(
    `data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`,
    { status, headers: { ...getCorsHeaders(request), 'Content-Type': 'text/event-stream' } }
  );
}

function sseFormat(token) {
  return `data: ${JSON.stringify({ token })}\n\n`;
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
    throw new Error(`DeepSeek API error: ${response.status}`);
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
          const existing = toolCallsByIndex.get(tc.index) || {
            id: '',
            function: { name: '', arguments: '' },
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name = tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
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

function replayBufferedAsSSE(tokens, request) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    for (const token of tokens) {
      await writer.write(encoder.encode(sseFormat(token)));
    }
    await writer.write(encoder.encode('data: [DONE]\n\n'));
    writer.close();
  })();

  return new Response(readable, {
    headers: {
      ...getCorsHeaders(request),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

async function runChatCompletion(messages, env, request) {
  let firstResult;
  // Buffered, not streamed live: finish_reason (tool call vs. stop) is only known
  // once this round ends, so every chat turn pays this latency, not just tool calls.
  const bufferedTokens = [];

  try {
    const response = await callDeepSeek(messages, env.DEEPSEEK_API_KEY, {
      tools: BGG_TOOL_DEFINITIONS,
    });
    firstResult = await parseDeepSeekStream(response, async (token) => {
      bufferedTokens.push(token);
    });
  } catch (e) {
    return sseError(request, e.message);
  }

  if (firstResult.finishReason !== 'tool_calls' || firstResult.toolCalls.length === 0) {
    return replayBufferedAsSSE(bufferedTokens, request);
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

  try {
    return await streamDeepSeek(followUp, env.DEEPSEEK_API_KEY, request);
  } catch (e) {
    return sseError(request, e.message);
  }
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
    const catalog = (await env.WIKI.get('catalog')) || '[]';
    const systemBase = SYSTEM_PROMPTS.discovery[language] ?? SYSTEM_PROMPTS.discovery.es;
    systemContent = `${systemBase}\n\nUser's game catalog (JSON):\n${catalog}`;
  } else if (mode === 'deep_dive' && game) {
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

    const promptFn = SYSTEM_PROMPTS.deep_dive[language] ?? SYSTEM_PROMPTS.deep_dive.es;
    systemContent = buildDeepDiveContext({
      base: entries[0],
      expansions: entries.slice(1),
      promptFn,
    });
  } else {
    return sseError(request, 'Invalid mode. Use "discovery" or "deep_dive" with a game slug.');
  }

  const cappedHistory = history.slice(-20);
  const messages = [
    { role: 'system', content: systemContent },
    ...cappedHistory,
    { role: 'user', content: message },
  ];

  return runChatCompletion(messages, env, request);
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

export { callDeepSeek, parseDeepSeekStream, streamDeepSeek, replayBufferedAsSSE, runChatCompletion };

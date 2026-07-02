import { buildDeepDiveContext } from './deepDiveContext.js';

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
IMPORTANTE: Solo responde preguntas relacionadas con juegos de mesa. Si el usuario pregunta sobre cualquier otro tema, responde amablemente que solo puedes ayudar con juegos de mesa y redirige la conversación.`,
    en: `You are a board game expert assistant. You help the user decide what to play for their game night.
You have access to the user's game catalog. Respond in English.
Some catalog entries include an "expansions" field listing the expansions the user owns for that game. Take them into account actively: if what the user wants (more players than the base game supports, more strategic depth, a different theme or mechanic) is better solved by adding one or more specific expansions, suggest the base game together with those expansions by name, rather than only ever recommending the bare base game.
Ask concrete questions when it helps decide: how many players, how much time they have, whether they want something lighter or more challenging. Use the answers to narrow down the available games and expansions.
Be concise and practical. Once the user has decided what to play, tell them to select the base game from the dropdown and check the expansions they chose (if the game has any) to get detailed in-game help.
IMPORTANT: Only answer questions related to board games. If the user asks about any other topic, kindly let them know you can only help with board games and redirect the conversation.`,
  },
  deep_dive: {
    es: (gameName) =>
      `Eres un experto en ${gameName}. Tienes acceso al wiki completo del juego incluyendo reglas, setup, guía de enseñanza, FAQ y glosario.
El contexto puede incluir el juego base junto con una o más expansiones que el usuario seleccionó. Cada sección de expansión describe solo lo que esa expansión agrega o modifica respecto al juego base, y no repite sus reglas — si la pregunta requiere combinar ambas, hazlo explícitamente y aclara qué parte viene del juego base y cuál de la expansión.
Responde en español. Preserva los nombres oficiales de componentes y mecánicas en inglés cuando no hay traducción establecida.
IMPORTANTE: Solo responde preguntas sobre ${gameName} y juegos de mesa en general. Si el usuario pregunta sobre cualquier otro tema, responde amablemente que solo puedes ayudar con preguntas sobre este juego y redirige la conversación.
FUENTE: Siempre indica de dónde viene tu respuesta:
- Si la información está en el wiki, comienza con "📖 Según el wiki:"
- Si la información NO está en el wiki y usas conocimiento general, comienza con "🧠 No está en el wiki — respondo con conocimiento general:"
- Si la respuesta combina ambas fuentes, usa "📖 Del wiki:" y "🧠 Conocimiento general:" para separar cada parte.`,
    en: (gameName) =>
      `You are an expert on ${gameName}. You have access to the complete game wiki including rules, setup, teaching guide, FAQ, and glossary.
The context may include the base game together with one or more expansions the user selected. Each expansion section describes only what that expansion adds or changes relative to the base game, and does not repeat its rules — if the question requires combining both, do so explicitly and make clear which part comes from the base game and which from the expansion.
Respond in English. Be precise about rules.
IMPORTANT: Only answer questions about ${gameName} and board games in general. If the user asks about any other topic, kindly let them know you can only help with questions about this game and redirect the conversation.
SOURCE: Always indicate where your answer comes from:
- If the information is in the wiki, start with "📖 From the wiki:"
- If the information is NOT in the wiki and you use general knowledge, start with "🧠 Not in the wiki — answering from general knowledge:"
- If the answer combines both, use "📖 From the wiki:" and "🧠 General knowledge:" to separate each part.`,
  },
};

function sseError(request, message) {
  return new Response(
    `data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`,
    { headers: { ...getCorsHeaders(request), 'Content-Type': 'text/event-stream' } }
  );
}

async function streamDeepSeek(messages, apiKey, request) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages, stream: true }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            await writer.write(encoder.encode('data: [DONE]\n\n'));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) {
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ token })}\n\n`)
              );
            }
          } catch {}
        }
      }
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (e) {
      await writer.write(
        encoder.encode(
          `data: ${JSON.stringify({ error: e.message })}\n\ndata: [DONE]\n\n`
        )
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

  try {
    return await streamDeepSeek(messages, env.DEEPSEEK_API_KEY, request);
  } catch (e) {
    return sseError(request, e.message);
  }
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

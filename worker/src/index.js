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
    es: `Eres un asistente experto en juegos de mesa. Ayudas al usuario a elegir un juego para su noche de juegos.
Tienes acceso al catálogo de juegos del usuario. Responde en español.
Preserva la terminología oficial en inglés cuando no hay traducción establecida (ej: "Worker Placement", "Area Control").
Sé conciso y práctico. Cuando el usuario haya elegido un juego, sugiere que lo seleccione para obtener ayuda detallada.`,
    en: `You are a board game expert assistant. You help the user choose a game for their game night.
You have access to the user's game catalog. Respond in English.
Be concise and practical. When the user has chosen a game, suggest they select it for detailed help.`,
  },
  deep_dive: {
    es: (gameName) =>
      `Eres un experto en ${gameName}. Tienes acceso al wiki completo del juego incluyendo reglas, setup, guía de enseñanza, FAQ y glosario.
Responde en español. Preserva los nombres oficiales de componentes y mecánicas en inglés cuando no hay traducción establecida.
Sé preciso con las reglas. Si algo no está en el wiki, dilo claramente.`,
    en: (gameName) =>
      `You are an expert on ${gameName}. You have access to the complete game wiki including rules, setup, teaching guide, FAQ, and glossary.
Respond in English. Be precise about rules. If something is not in the wiki, say so clearly.`,
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
    body: JSON.stringify({ model: 'deepseek-chat', messages, stream: true }),
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
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
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

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return sseError(request, 'Invalid JSON body');
  }

  const { message, history = [], mode = 'discovery', game = null, language = 'es' } = body;

  if (!message) return sseError(request, 'message is required');

  if (mode === 'discovery') {
    const catalog = (await env.WIKI.get('catalog')) || '[]';
    const systemBase = SYSTEM_PROMPTS.discovery[language] ?? SYSTEM_PROMPTS.discovery.es;
    const systemContent = `${systemBase}\n\nUser's game catalog (JSON):\n${catalog}`;
    const messages = [
      { role: 'system', content: systemContent },
      ...history,
      { role: 'user', content: message },
    ];
    try {
      return await streamDeepSeek(messages, env.DEEPSEEK_API_KEY, request);
    } catch (e) {
      return sseError(request, e.message);
    }
  }

  return sseError(request, 'Invalid mode. Use "discovery" or "deep_dive".');
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
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }
    return new Response('not found', { status: 404, headers: cors });
  },
};

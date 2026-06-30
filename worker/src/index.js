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

async function handleGetGames(request, env) {
  const catalog = await env.WIKI.get('catalog');
  return new Response(catalog || '[]', {
    status: 200,
    headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
  });
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

    return new Response('not found', { status: 404, headers: cors });
  },
};

import { XMLParser } from 'fast-xml-parser';

const BASE_URL = 'https://www.boardgamegeek.com/xmlapi2';

const REPEATABLE_PATHS = new Set([
  'items.item',
  'items.item.name',
  'items.item.link',
  'forumlist.forum',
  'forum.threads.thread',
  'thread.articles.article',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (_name, jpath) => REPEATABLE_PATHS.has(jpath),
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function bggFetch(path, params, token) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 401) {
    throw new Error('BGG_TOKEN invalido o expirado');
  }
  if (!response.ok) {
    throw new Error(`BGG API error: ${response.status}`);
  }
  const text = await response.text();
  return parser.parse(text);
}

export const BGG_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'bgg_search_game',
      description: 'Search BoardGameGeek for games by name. Returns id, name, and year for each match.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Game name to search for' },
          type: {
            type: 'string',
            enum: ['boardgame', 'boardgameexpansion', 'all'],
            description: 'Restrict to base games, expansions, or all types. Defaults to all.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bgg_get_game_details',
      description: 'Get rating, complexity weight, player count, mechanics, categories, and expansions for a specific BGG game id.',
      parameters: {
        type: 'object',
        properties: {
          bgg_id: { type: 'integer', description: 'BoardGameGeek numeric game id' },
        },
        required: ['bgg_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bgg_search_forum',
      description: "Search a game's BGG forums for threads whose subject matches a term (rules questions, fan variants, unofficial solo modes, etc).",
      parameters: {
        type: 'object',
        properties: {
          bgg_id: { type: 'integer', description: 'BoardGameGeek numeric game id' },
          query: { type: 'string', description: 'Term to look for in thread subjects, e.g. "solo variant" or "rules question"' },
        },
        required: ['bgg_id', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bgg_get_thread',
      description: 'Get the full post content of a specific BGG forum thread by id.',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'integer', description: 'BoardGameGeek numeric thread id' },
        },
        required: ['thread_id'],
      },
    },
  },
];

async function searchGame({ query, type }, token) {
  const params = { query };
  if (type && type !== 'all') params.type = type;
  const data = await bggFetch('/search', params, token);
  const items = asArray(data.items?.item);
  return items.map((item) => {
    const names = asArray(item.name);
    return {
      id: Number(item['@_id']),
      type: item['@_type'],
      name: names.find((n) => n['@_type'] === 'primary')?.['@_value'] ?? names[0]?.['@_value'] ?? null,
      year: item.yearpublished?.['@_value'] ? Number(item.yearpublished['@_value']) : null,
    };
  });
}

async function getGameDetails({ bgg_id }, token) {
  const data = await bggFetch('/thing', { id: bgg_id, stats: 1 }, token);
  const item = asArray(data.items?.item)[0];
  if (!item) throw new Error(`Game ${bgg_id} not found`);

  const names = asArray(item.name);
  const links = asArray(item.link);
  const byType = (t) =>
    links.filter((l) => l['@_type'] === t).map((l) => ({ id: Number(l['@_id']), name: l['@_value'] }));

  return {
    id: Number(item['@_id']),
    name: names.find((n) => n['@_type'] === 'primary')?.['@_value'] ?? names[0]?.['@_value'] ?? null,
    year: item.yearpublished?.['@_value'] ? Number(item.yearpublished['@_value']) : null,
    min_players: item.minplayers?.['@_value'] ? Number(item.minplayers['@_value']) : null,
    max_players: item.maxplayers?.['@_value'] ? Number(item.maxplayers['@_value']) : null,
    playing_time: item.playingtime?.['@_value'] ? Number(item.playingtime['@_value']) : null,
    rating: item.statistics?.ratings?.average?.['@_value'] ? Number(item.statistics.ratings.average['@_value']) : null,
    weight: item.statistics?.ratings?.averageweight?.['@_value'] ? Number(item.statistics.ratings.averageweight['@_value']) : null,
    categories: byType('boardgamecategory').map((c) => c.name),
    mechanics: byType('boardgamemechanic').map((m) => m.name),
    expansions: byType('boardgameexpansion'),
  };
}

export async function executeBggTool(name, args, token) {
  try {
    switch (name) {
      case 'bgg_search_game':
        return { result: await searchGame(args, token) };
      case 'bgg_get_game_details':
        return { result: await getGameDetails(args, token) };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

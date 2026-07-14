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
  parseTagValue: false,
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
      description: 'Search BoardGameGeek for games by name. Accepts several names at once — batch every game you need to look up into a single call instead of one call per game. Returns id, name, and year for each match.',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Game name(s) to search for',
          },
          type: {
            type: 'string',
            enum: ['boardgame', 'boardgameexpansion', 'all'],
            description: 'Restrict to base games, expansions, or all types. Defaults to all.',
          },
        },
        required: ['queries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bgg_get_game_details',
      description: 'Get rating, complexity weight, player count, mechanics, categories, and expansions for one or more BGG game ids. Pass all the ids you need in a single call (e.g. when comparing several games) instead of calling once per game.',
      parameters: {
        type: 'object',
        properties: {
          bgg_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'BoardGameGeek numeric game ids (one or more)',
          },
        },
        required: ['bgg_ids'],
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

// BGG throttles aggressive parallel clients, so batched searches go out in
// small waves rather than all at once.
const SEARCH_CONCURRENCY = 5;
// A batched search can span a dozen games; without a cap the fuzzy matches
// would flood the synthesis context.
const MAX_MATCHES_PER_QUERY = 10;

async function searchOneGame(query, type, token) {
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

async function searchGame({ queries, query, type }, token) {
  // query is the legacy single-name form; models occasionally still emit it.
  const list = (Array.isArray(queries) && queries.length ? queries : [query]).filter(
    (q) => typeof q === 'string' && q.trim()
  );
  if (!list.length) throw new Error('queries is required');
  if (list.length === 1) return searchOneGame(list[0], type, token);

  const perQuery = [];
  for (let i = 0; i < list.length; i += SEARCH_CONCURRENCY) {
    const chunk = list.slice(i, i + SEARCH_CONCURRENCY);
    perQuery.push(...(await Promise.all(chunk.map((q) => searchOneGame(q, type, token)))));
  }
  return list.map((q, i) => ({ query: q, matches: perQuery[i].slice(0, MAX_MATCHES_PER_QUERY) }));
}

function parseGameItem(item) {
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

async function getGameDetails({ bgg_ids, bgg_id }, token) {
  // bgg_id is the legacy single-id form; models occasionally still emit it.
  const ids = (Array.isArray(bgg_ids) && bgg_ids.length ? bgg_ids : [bgg_id]).filter((id) => id != null);
  if (!ids.length) throw new Error('bgg_ids is required');
  const data = await bggFetch('/thing', { id: ids.join(','), stats: 1 }, token);
  const items = asArray(data.items?.item);
  if (!items.length) throw new Error(`Game ${ids.join(', ')} not found`);
  return items.map(parseGameItem);
}

async function searchForum({ bgg_id, query }, token) {
  const listData = await bggFetch('/forumlist', { id: bgg_id, type: 'thing' }, token);
  const forums = asArray(listData.forumlist?.forum);

  const perForumResults = await Promise.all(
    forums.map(async (forum) => {
      const forumData = await bggFetch('/forum', { id: forum['@_id'] }, token);
      const threads = asArray(forumData.forum?.threads?.thread);
      return threads.map((thread) => ({
        id: Number(thread['@_id']),
        subject: thread['@_subject'],
        author: thread['@_author'],
        forum: forum['@_title'],
      }));
    })
  );

  const term = query.toLowerCase();
  return perForumResults
    .flat()
    .filter((thread) => thread.subject?.toLowerCase().includes(term))
    .slice(0, 10);
}

const MAX_THREAD_POSTS = 10;
const MAX_POST_CHARS = 1500;

function stripQuotes(text) {
  // BGG supports [q]/[/q] (native) and [quote]/[/quote] (a synonym added later),
  // both with or without attribution (e.g. [q=user], [quote=user]).
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

export async function executeBggTool(name, args, token) {
  try {
    switch (name) {
      case 'bgg_search_game':
        return { result: await searchGame(args, token) };
      case 'bgg_get_game_details':
        return { result: await getGameDetails(args, token) };
      case 'bgg_search_forum':
        return { result: await searchForum(args, token) };
      case 'bgg_get_thread':
        return { result: await getThread(args, token) };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

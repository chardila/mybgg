import { describe, it, expect, vi, afterEach } from 'vitest';
import { BGG_TOOL_DEFINITIONS, executeBggTool } from '../src/bggTools.js';

function fakeXmlResponse(xml, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => xml };
}

describe('BGG_TOOL_DEFINITIONS', () => {
  it('declares all 4 tools by name', () => {
    const names = BGG_TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names).toEqual([
      'bgg_search_game',
      'bgg_get_game_details',
      'bgg_search_forum',
      'bgg_get_thread',
    ]);
  });
});

describe('executeBggTool: bgg_search_game', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns matching games with id, name, and year', async () => {
    const xml = `<?xml version="1.0"?>
      <items total="1" termsofuse="x">
        <item type="boardgame" id="266192">
          <name type="primary" value="Wingspan"/>
          <yearpublished value="2019"/>
        </item>
      </items>`;
    const mockFetch = vi.fn().mockResolvedValue(fakeXmlResponse(xml));
    vi.stubGlobal('fetch', mockFetch);

    const { result, error } = await executeBggTool('bgg_search_game', { query: 'Wingspan' }, 'tok123');

    expect(error).toBeUndefined();
    expect(result).toEqual([{ id: 266192, type: 'boardgame', name: 'Wingspan', year: 2019 }]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/search?query=Wingspan');
    expect(opts.headers.Authorization).toBe('Bearer tok123');
  });

  it('returns an empty array when BGG has no matches', async () => {
    const xml = `<?xml version="1.0"?><items total="0" termsofuse="x"></items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_search_game', { query: 'zzz-nonexistent' }, 'tok123');
    expect(result).toEqual([]);
  });

  it('runs one BGG search per query and groups results when given several queries', async () => {
    const xmlFor = (id, name) => `<?xml version="1.0"?>
      <items total="1" termsofuse="x">
        <item type="boardgame" id="${id}">
          <name type="primary" value="${name}"/>
          <yearpublished value="2019"/>
        </item>
      </items>`;
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeXmlResponse(xmlFor(266192, 'Wingspan')))
      .mockResolvedValueOnce(fakeXmlResponse(xmlFor(167791, 'Terraforming Mars')));
    vi.stubGlobal('fetch', mockFetch);

    const { result, error } = await executeBggTool(
      'bgg_search_game',
      { queries: ['Wingspan', 'Terraforming Mars'] },
      'tok123'
    );

    expect(error).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { query: 'Wingspan', matches: [{ id: 266192, type: 'boardgame', name: 'Wingspan', year: 2019 }] },
      { query: 'Terraforming Mars', matches: [{ id: 167791, type: 'boardgame', name: 'Terraforming Mars', year: 2019 }] },
    ]);
  });

  it('keeps the flat result shape when queries has a single entry', async () => {
    const xml = `<?xml version="1.0"?>
      <items total="1" termsofuse="x">
        <item type="boardgame" id="266192">
          <name type="primary" value="Wingspan"/>
          <yearpublished value="2019"/>
        </item>
      </items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_search_game', { queries: ['Wingspan'] }, 'tok123');
    expect(result).toEqual([{ id: 266192, type: 'boardgame', name: 'Wingspan', year: 2019 }]);
  });

  it('caps matches per query in batched searches', async () => {
    const manyItems = Array.from(
      { length: 15 },
      (_, i) => `<item type="boardgame" id="${i + 1}"><name type="primary" value="Catan ${i + 1}"/></item>`
    ).join('');
    const xml = `<?xml version="1.0"?><items total="15" termsofuse="x">${manyItems}</items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_search_game', { queries: ['Catan', 'Carcassonne'] }, 'tok123');
    expect(result[0].matches).toHaveLength(10);
    expect(result[1].matches).toHaveLength(10);
  });

  it('returns an error when called without any query', async () => {
    const { result, error } = await executeBggTool('bgg_search_game', {}, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('queries is required');
  });
});

describe('executeBggTool: bgg_get_game_details', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns rating, weight, players, mechanics, categories, expansions', async () => {
    const xml = `<?xml version="1.0"?>
      <items termsofuse="x">
        <item type="boardgame" id="266192">
          <name type="primary" sortindex="1" value="Wingspan"/>
          <name type="alternate" sortindex="1" value="Wingspan Alt"/>
          <yearpublished value="2019"/>
          <minplayers value="1"/>
          <maxplayers value="5"/>
          <playingtime value="70"/>
          <link type="boardgamecategory" id="1024" value="Animals"/>
          <link type="boardgamemechanic" id="2040" value="Engine Building"/>
          <link type="boardgameexpansion" id="300217" value="Wingspan: European Expansion"/>
          <statistics>
            <ratings>
              <average value="8.1"/>
              <averageweight value="2.4"/>
            </ratings>
          </statistics>
        </item>
      </items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_game_details', { bgg_ids: [266192] }, 'tok123');

    expect(error).toBeUndefined();
    expect(result).toEqual([{
      id: 266192,
      name: 'Wingspan',
      year: 2019,
      min_players: 1,
      max_players: 5,
      playing_time: 70,
      rating: 8.1,
      weight: 2.4,
      categories: ['Animals'],
      mechanics: ['Engine Building'],
      expansions: [{ id: 300217, name: 'Wingspan: European Expansion' }],
    }]);
  });

  it('fetches several games in a single BGG request when given multiple ids', async () => {
    const xml = `<?xml version="1.0"?>
      <items termsofuse="x">
        <item type="boardgame" id="266192">
          <name type="primary" sortindex="1" value="Wingspan"/>
          <yearpublished value="2019"/>
        </item>
        <item type="boardgame" id="167791">
          <name type="primary" sortindex="1" value="Terraforming Mars"/>
          <yearpublished value="2016"/>
        </item>
      </items>`;
    const mockFetch = vi.fn().mockResolvedValue(fakeXmlResponse(xml));
    vi.stubGlobal('fetch', mockFetch);

    const { result, error } = await executeBggTool('bgg_get_game_details', { bgg_ids: [266192, 167791] }, 'tok123');

    expect(error).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('id=266192%2C167791');
    expect(result.map((g) => g.name)).toEqual(['Wingspan', 'Terraforming Mars']);
  });

  it('still accepts the legacy single bgg_id argument', async () => {
    const xml = `<?xml version="1.0"?>
      <items termsofuse="x">
        <item type="boardgame" id="266192">
          <name type="primary" sortindex="1" value="Wingspan"/>
        </item>
      </items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_game_details', { bgg_id: 266192 }, 'tok123');
    expect(error).toBeUndefined();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Wingspan');
  });

  it('returns an error when no requested id exists', async () => {
    const xml = `<?xml version="1.0"?><items termsofuse="x"></items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_game_details', { bgg_ids: [999999999] }, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('Game 999999999 not found');
  });

  it('returns an error when called without any id', async () => {
    const { result, error } = await executeBggTool('bgg_get_game_details', {}, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('bgg_ids is required');
  });
});

describe('executeBggTool: bgg_search_forum', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns threads whose subject matches the query, across all forums', async () => {
    const forumlistXml = `<?xml version="1.0"?>
      <forumlist type="thing" id="266192" termsofuse="x">
        <forum id="1" title="Rules" noposting="0" description="d" numthreads="1" numposts="1" lastpostdate="d"/>
        <forum id="2" title="General" noposting="0" description="d" numthreads="1" numposts="1" lastpostdate="d"/>
      </forumlist>`;
    const rulesForumXml = `<?xml version="1.0"?>
      <forum id="1" title="Rules" numthreads="1" numposts="1" termsofuse="x">
        <threads>
          <thread id="1000" subject="Unofficial solo variant" author="user1" numarticles="2" postdate="d" lastpostdate="d"/>
        </threads>
      </forum>`;
    const generalForumXml = `<?xml version="1.0"?>
      <forum id="2" title="General" numthreads="1" numposts="1" termsofuse="x">
        <threads>
          <thread id="1001" subject="Best insert for the box" author="user2" numarticles="3" postdate="d" lastpostdate="d"/>
        </threads>
      </forum>`;

    const mockFetch = vi.fn((url) => {
      const text = url.includes('/forumlist')
        ? forumlistXml
        : url.includes('id=1')
        ? rulesForumXml
        : generalForumXml;
      return Promise.resolve(fakeXmlResponse(text));
    });
    vi.stubGlobal('fetch', mockFetch);

    const { result, error } = await executeBggTool(
      'bgg_search_forum',
      { bgg_id: 266192, query: 'solo' },
      'tok123'
    );

    expect(error).toBeUndefined();
    expect(result).toEqual([{ id: 1000, subject: 'Unofficial solo variant', author: 'user1', forum: 'Rules' }]);
  });

  it('returns an empty array when nothing matches', async () => {
    const forumlistXml = `<?xml version="1.0"?>
      <forumlist type="thing" id="266192" termsofuse="x">
        <forum id="1" title="Rules" noposting="0" description="d" numthreads="0" numposts="0" lastpostdate="d"/>
      </forumlist>`;
    const rulesForumXml = `<?xml version="1.0"?>
      <forum id="1" title="Rules" numthreads="0" numposts="0" termsofuse="x"><threads></threads></forum>`;

    vi.stubGlobal(
      'fetch',
      vi.fn((url) =>
        Promise.resolve(fakeXmlResponse(url.includes('/forumlist') ? forumlistXml : rulesForumXml))
      )
    );

    const { result } = await executeBggTool('bgg_search_forum', { bgg_id: 266192, query: 'zzz' }, 'tok123');
    expect(result).toEqual([]);
  });
});

describe('executeBggTool: bgg_get_thread', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the thread subject and each post', async () => {
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="2">
        <subject>Unofficial solo variant</subject>
        <link>https://boardgamegeek.com/thread/1000</link>
        <articles>
          <article id="1" username="user1" link="l" postdate="2026-01-01" editdate="2026-01-01" numedits="0">
            <subject>Unofficial solo variant</subject>
            <body><![CDATA[Has anyone tried a solo mode?]]></body>
          </article>
          <article id="2" username="user3" link="l" postdate="2026-01-02" editdate="2026-01-02" numedits="0">
            <subject>Re: Unofficial solo variant</subject>
            <body><![CDATA[Check the Files section.]]></body>
          </article>
        </articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(error).toBeUndefined();
    expect(result).toEqual({
      id: 1000,
      subject: 'Unofficial solo variant',
      posts: [
        { author: 'user1', date: '2026-01-01', text: 'Has anyone tried a solo mode?' },
        { author: 'user3', date: '2026-01-02', text: 'Check the Files section.' },
      ],
    });
  });

  it('strips [quote=user]...[/quote] blocks, including the attribution tag', async () => {
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="1">
        <subject>Rules question</subject>
        <link>l</link>
        <articles>
          <article id="1" username="user1" link="l" postdate="2026-01-01" editdate="2026-01-01" numedits="0">
            <subject>Rules question</subject>
            <body><![CDATA[[quote=user2]You always draw first[/quote]Actually that's wrong, you draw last.]]></body>
          </article>
        </articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(result.posts[0].text).toBe("Actually that's wrong, you draw last.");
  });

  it('strips [q]...[/q] blocks with no attribution', async () => {
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="1">
        <subject>Rules question</subject>
        <link>l</link>
        <articles>
          <article id="1" username="user1" link="l" postdate="2026-01-01" editdate="2026-01-01" numedits="0">
            <subject>Rules question</subject>
            <body><![CDATA[[q]Some earlier post[/q]I agree with this.]]></body>
          </article>
        </articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(result.posts[0].text).toBe('I agree with this.');
  });

  it('truncates posts longer than 1500 characters', async () => {
    const longText = 'a'.repeat(2000);
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="1">
        <subject>Long post</subject>
        <link>l</link>
        <articles>
          <article id="1" username="user1" link="l" postdate="2026-01-01" editdate="2026-01-01" numedits="0">
            <subject>Long post</subject>
            <body><![CDATA[${longText}]]></body>
          </article>
        </articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(result.posts[0].text).toBe(`${'a'.repeat(1500)}…`);
  });

  it('limits results to the first 10 posts when the thread has more', async () => {
    const articles = Array.from({ length: 12 }, (_, i) => `
          <article id="${i}" username="user${i}" link="l" postdate="2026-01-0${(i % 9) + 1}" editdate="2026-01-01" numedits="0">
            <subject>Re: Long thread</subject>
            <body><![CDATA[Post number ${i}]]></body>
          </article>`).join('');
    const xml = `<?xml version="1.0"?>
      <thread id="1000" numarticles="12">
        <subject>Long thread</subject>
        <link>l</link>
        <articles>${articles}</articles>
      </thread>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result } = await executeBggTool('bgg_get_thread', { thread_id: 1000 }, 'tok123');

    expect(result.posts).toHaveLength(10);
    expect(result.posts[0].text).toBe('Post number 0');
    expect(result.posts[9].text).toBe('Post number 9');
  });

  it('returns an error when the thread does not exist', async () => {
    const xml = `<?xml version="1.0"?><error><message>Thread not found</message></error>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_thread', { thread_id: 999999999 }, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('Thread 999999999 not found');
  });
});

describe('executeBggTool: errors and unknown tools', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns an error object when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { result, error } = await executeBggTool('bgg_search_game', { query: 'x' }, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('network down');
  });

  it('returns an auth error on a 401 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse('', { ok: false, status: 401 })));
    const { error } = await executeBggTool('bgg_search_game', { query: 'x' }, 'tok123');
    expect(error).toBe('BGG_TOKEN invalido o expirado');
  });

  it('returns a generic error on a 5xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse('', { ok: false, status: 503 })));
    const { error } = await executeBggTool('bgg_search_game', { query: 'x' }, 'tok123');
    expect(error).toBe('BGG API error: 503');
  });

  it('returns an error for an unknown tool name', async () => {
    const { error } = await executeBggTool('bgg_nonexistent', {}, 'tok123');
    expect(error).toBe('Unknown tool: bgg_nonexistent');
  });
});

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

    const { result, error } = await executeBggTool('bgg_get_game_details', { bgg_id: 266192 }, 'tok123');

    expect(error).toBeUndefined();
    expect(result).toEqual({
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
    });
  });

  it('returns an error when the game id does not exist', async () => {
    const xml = `<?xml version="1.0"?><items termsofuse="x"></items>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeXmlResponse(xml)));

    const { result, error } = await executeBggTool('bgg_get_game_details', { bgg_id: 999999999 }, 'tok123');
    expect(result).toBeUndefined();
    expect(error).toBe('Game 999999999 not found');
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

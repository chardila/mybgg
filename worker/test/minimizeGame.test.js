import { describe, it, expect } from 'vitest';
import { minimizeGame, parseCatalog } from '../src/index.js';

describe('minimizeGame', () => {
  it('keeps only the fields the discovery prompt needs', () => {
    const game = {
      slug: 'wingspan-2019',
      name: 'Wingspan',
      players: '1-5',
      weight: '2.4',
      playing_time: '',
      mechanics: ['Engine Building'],
      categories: ['Animals'],
      edition: '2019',
      status: 'owned',
      rank: '23',
      base_game_slug: '',
      numplays: 3,
      expansions: [],
    };

    expect(minimizeGame(game)).toEqual({
      name: 'Wingspan',
      players: '1-5',
      weight: '2.4',
      mechanics: ['Engine Building'],
      categories: ['Animals'],
      status: 'owned',
      rank: '23',
      numplays: 3,
    });
  });

  it('omits the expansions key entirely when the game has none', () => {
    const game = {
      slug: 'foo-2020',
      name: 'Foo',
      players: '2-4',
      weight: '1.0',
      playing_time: '',
      mechanics: [],
      categories: [],
      edition: '2020',
      status: 'owned',
      rank: '9999',
      base_game_slug: '',
      expansions: [],
    };

    expect(minimizeGame(game)).not.toHaveProperty('expansions');
  });

  it('defaults numplays to 0 when missing from the source game', () => {
    const game = {
      slug: 'foo-2020',
      name: 'Foo',
      players: '2-4',
      weight: '1.0',
      playing_time: '',
      mechanics: [],
      categories: [],
      edition: '2020',
      status: 'owned',
      rank: '9999',
      base_game_slug: '',
      expansions: [],
    };

    expect(minimizeGame(game).numplays).toBe(0);
  });

  it('minimizes nested expansions without recursing into their own rank or expansions', () => {
    const game = {
      slug: 'wingspan-2019',
      name: 'Wingspan',
      players: '1-5',
      weight: '2.4',
      playing_time: '',
      mechanics: ['Engine Building'],
      categories: ['Animals'],
      edition: '2019',
      status: 'owned',
      rank: '23',
      base_game_slug: '',
      numplays: 5,
      expansions: [
        {
          slug: 'wingspan-european-expansion-2019',
          name: 'Wingspan: European Expansion',
          players: '1-5',
          weight: '2.5',
          playing_time: '',
          mechanics: ['Engine Building'],
          categories: ['Animals'],
          edition: '2019',
          status: 'owned',
          rank: 'Not Ranked',
          base_game_slug: 'wingspan-2019',
          numplays: 0,
          expansions: [],
        },
      ],
    };

    expect(minimizeGame(game)).toEqual({
      name: 'Wingspan',
      players: '1-5',
      weight: '2.4',
      mechanics: ['Engine Building'],
      categories: ['Animals'],
      status: 'owned',
      rank: '23',
      numplays: 5,
      expansions: [
        {
          name: 'Wingspan: European Expansion',
          players: '1-5',
          weight: '2.5',
          mechanics: ['Engine Building'],
          categories: ['Animals'],
          status: 'owned',
          numplays: 0,
        },
      ],
    });
  });

  it('handles an empty catalog', () => {
    expect([].map((g) => minimizeGame(g))).toEqual([]);
  });
});

describe('parseCatalog', () => {
  it('parses valid JSON array and returns it', () => {
    const validArray = JSON.stringify([{ name: 'Game 1' }, { name: 'Game 2' }]);
    const result = parseCatalog(validArray);
    expect(result).toEqual([{ name: 'Game 1' }, { name: 'Game 2' }]);
  });

  it('returns empty array for empty JSON array string', () => {
    const emptyArray = JSON.stringify([]);
    const result = parseCatalog(emptyArray);
    expect(result).toEqual([]);
  });

  it('returns empty array when JSON is malformed', () => {
    const malformed = '{ invalid json';
    const result = parseCatalog(malformed);
    expect(result).toEqual([]);
  });

  it('returns empty array when JSON is valid but not an array (object)', () => {
    const validObject = JSON.stringify({ games: [] });
    const result = parseCatalog(validObject);
    expect(result).toEqual([]);
  });

  it('returns empty array when JSON is valid but is null', () => {
    const nullValue = JSON.stringify(null);
    const result = parseCatalog(nullValue);
    expect(result).toEqual([]);
  });

  it('returns empty array when JSON is valid but is a string', () => {
    const stringValue = JSON.stringify('not an array');
    const result = parseCatalog(stringValue);
    expect(result).toEqual([]);
  });

  it('returns empty array when JSON is valid but is a number', () => {
    const numberValue = JSON.stringify(42);
    const result = parseCatalog(numberValue);
    expect(result).toEqual([]);
  });
});

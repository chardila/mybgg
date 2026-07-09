import { describe, it, expect } from 'vitest';
import { minimizeGame } from '../src/index.js';

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
      expansions: [
        {
          name: 'Wingspan: European Expansion',
          players: '1-5',
          weight: '2.5',
          mechanics: ['Engine Building'],
          categories: ['Animals'],
          status: 'owned',
        },
      ],
    });
  });

  it('handles an empty catalog', () => {
    expect([].map((g) => minimizeGame(g))).toEqual([]);
  });
});

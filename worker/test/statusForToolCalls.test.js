import { describe, it, expect } from 'vitest';
import { statusForToolCalls } from '../src/index.js';

function toolCall(name) {
  return { function: { name } };
}

describe('statusForToolCalls', () => {
  it('returns "searching" for a single bgg_search_game call', () => {
    expect(statusForToolCalls([toolCall('bgg_search_game')])).toBe('searching');
  });

  it('returns "details" for a single bgg_get_game_details call', () => {
    expect(statusForToolCalls([toolCall('bgg_get_game_details')])).toBe('details');
  });

  it('returns "forum" for a single bgg_search_forum call', () => {
    expect(statusForToolCalls([toolCall('bgg_search_forum')])).toBe('forum');
  });

  it('returns "forum" for a single bgg_get_thread call', () => {
    expect(statusForToolCalls([toolCall('bgg_get_thread')])).toBe('forum');
  });

  it('returns "details" when multiple calls repeat the same non-search tool', () => {
    expect(
      statusForToolCalls([toolCall('bgg_get_game_details'), toolCall('bgg_get_game_details')])
    ).toBe('details');
  });

  it('falls back to "searching" for a mixed set of tool names', () => {
    expect(
      statusForToolCalls([toolCall('bgg_search_game'), toolCall('bgg_get_game_details')])
    ).toBe('searching');
  });
});

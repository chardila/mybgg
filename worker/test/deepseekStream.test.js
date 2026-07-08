import { describe, it, expect, vi, afterEach } from 'vitest';
import { callDeepSeek, parseDeepSeekStream, streamDeepSeek } from '../src/index.js';
import { fakeSSEResponse } from './sseHelpers.js';

async function readAllText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe('callDeepSeek', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends model, messages, and stream:true', async () => {
    const mockFetch = vi.fn().mockResolvedValue(fakeSSEResponse([]));
    vi.stubGlobal('fetch', mockFetch);

    const messages = [{ role: 'user', content: 'hi' }];
    await callDeepSeek(messages, 'key123', {});

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer key123', 'Content-Type': 'application/json' },
      })
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      model: 'deepseek-v4-flash',
      messages,
      stream: true,
    });
  });

  it('includes tools in the body when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(fakeSSEResponse([]));
    vi.stubGlobal('fetch', mockFetch);
    const tools = [{ type: 'function', function: { name: 'x' } }];

    await callDeepSeek([{ role: 'user', content: 'hi' }], 'key123', { tools });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).tools).toEqual(tools);
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeSSEResponse([], { ok: false, status: 500 })));
    await expect(callDeepSeek([{ role: 'user', content: 'hi' }], 'key123', {})).rejects.toThrow(
      'DeepSeek API error: 500'
    );
  });
});

describe('parseDeepSeekStream', () => {
  it('accumulates content tokens and returns finishReason "stop"', async () => {
    const response = fakeSSEResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hola' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: ' mundo' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);

    const tokens = [];
    const result = await parseDeepSeekStream(response, async (t) => tokens.push(t));

    expect(tokens).toEqual(['Hola', ' mundo']);
    expect(result).toEqual({ finishReason: 'stop', toolCalls: [] });
  });

  it('reconstructs chunked tool_calls and returns finishReason "tool_calls"', async () => {
    const response = fakeSSEResponse([
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bgg_search_game', arguments: '' } }] } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Wingspan"}' } }] } }],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ]);

    const result = await parseDeepSeekStream(response, async () => {});

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', function: { name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' } },
    ]);
  });
});

describe('streamDeepSeek', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams content tokens as SSE frames ending in [DONE]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hola' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      )
    );

    const fakeRequest = new Request('https://example.com/api/chat', {
      headers: { Origin: 'https://bgg.cardila.com' },
    });
    const response = await streamDeepSeek([{ role: 'user', content: 'hola' }], 'key123', fakeRequest);
    const text = await readAllText(response);

    expect(text).toContain('data: {"token":"Hola"}');
    expect(text).toContain('data: [DONE]');
  });

  it('rejects when the DeepSeek call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeSSEResponse([], { ok: false, status: 500 })));
    const fakeRequest = new Request('https://example.com/api/chat');

    await expect(
      streamDeepSeek([{ role: 'user', content: 'hola' }], 'key123', fakeRequest)
    ).rejects.toThrow('DeepSeek API error: 500');
  });
});

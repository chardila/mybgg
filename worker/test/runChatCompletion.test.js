import { describe, it, expect, vi, afterEach } from 'vitest';
import { runChatCompletion } from '../src/index.js';
import { executeBggTool } from '../src/bggTools.js';
import { fakeSSEResponse, readAllText } from './sseHelpers.js';

vi.mock('../src/bggTools.js', () => ({
  BGG_TOOL_DEFINITIONS: [{ type: 'function', function: { name: 'bgg_search_game' } }],
  executeBggTool: vi.fn(),
}));

function fakeRequest() {
  return new Request('https://example.com/api/chat', { headers: { Origin: 'https://bgg.cardila.com' } });
}

function toolCallSSE(toolCalls) {
  return fakeSSEResponse([
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
        },
      ],
    }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
}

const noToolCallSSE = () =>
  fakeSSEResponse([
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hola' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]);

const env = { DEEPSEEK_API_KEY: 'key123', BGG_TOKEN: 'bgg-token' };

describe('runChatCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    executeBggTool.mockReset();
  });

  it('replays buffered content when no tool call is requested', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(text).toContain('data: {"token":"Hola"}');
    expect(text).toContain('data: [DONE]');
    expect(executeBggTool).not.toHaveBeenCalled();
  });

  it('executes a requested tool call and streams the follow-up answer', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      );
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion(
      [{ role: 'user', content: '¿qué expansión compro?' }],
      env,
      fakeRequest()
    );
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(executeBggTool).toHaveBeenCalledWith('bgg_search_game', { query: 'Wingspan' }, 'bgg-token');
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');

    const round2Body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = round2Body.messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toBe(JSON.stringify({ result: [{ id: 1, name: 'Wingspan' }] }));
    expect(round2Body.tools).toBeUndefined();
  });

  it('executes at most 3 tool calls per round', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const fiveToolCalls = Array.from({ length: 5 }, (_, i) => ({
      id: `call_${i}`,
      name: 'bgg_search_game',
      arguments: '{"query":"x"}',
    }));
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE(fiveToolCalls))
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());

    expect(executeBggTool).toHaveBeenCalledTimes(3);
  });

  it('passes a tool execution error through as the tool message content without aborting', async () => {
    executeBggTool.mockResolvedValue({ error: 'BGG unavailable' });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    const round2Body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = round2Body.messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toBe(JSON.stringify({ error: 'BGG unavailable' }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('never attempts a third round even if the follow-up response also requests tool calls', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"x"}' }]))
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_2', name: 'bgg_search_game', arguments: '{"query":"y"}' }]));
    vi.stubGlobal('fetch', mockFetch);

    await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(executeBggTool).toHaveBeenCalledTimes(1);
  });
});

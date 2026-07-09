import { describe, it, expect, vi, afterEach } from 'vitest';
import { runChatCompletion } from '../src/index.js';
import { executeBggTool } from '../src/bggTools.js';
import { fakeSSEResponse, readAllText } from './sseHelpers.js';

vi.mock('../src/bggTools.js', () => ({
  BGG_TOOL_DEFINITIONS: [{ type: 'function', function: { name: 'bgg_search_game' } }],
  executeBggTool: vi.fn(),
}));

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

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

// Gemini deciding, after seeing tool results, that it doesn't need to call
// anything else. Content is irrelevant — it's discarded once tools have
// already been called in an earlier round.
const toolRoundDoneSSE = () =>
  fakeSSEResponse([JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })]);

const dsmlLeakSSE = () =>
  fakeSSEResponse([
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            content:
              '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bgg_get_game_details">\n<｜｜DSML｜｜parameter name="id" string="false">266192</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
          },
        },
      ],
    }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]);

const incompleteStreamSSE = () =>
  fakeSSEResponse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'Ho' } }] })]);

function extractStatuses(text) {
  return [...text.matchAll(/data: (\{.*?\})\n/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    })
    .filter((frame) => frame && frame.status)
    .map((frame) => frame.status);
}

const env = { DEEPSEEK_API_KEY: 'key123', GEMINI_API_KEY: 'test-gemini-key', BGG_TOKEN: 'bgg-token' };

describe('runChatCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    executeBggTool.mockReset();
  });

  it('calls Gemini for both the tool round and the confirmation round, then DeepSeek for synthesis', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }])
      )
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      );
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest());
    await readAllText(response);

    expect(mockFetch.mock.calls[0][0]).toBe(GEMINI_URL);
    expect(mockFetch.mock.calls[1][0]).toBe(GEMINI_URL);
    expect(mockFetch.mock.calls[2][0]).toBe(DEEPSEEK_URL);

    const synthesisBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    const assistantMessage = synthesisBody.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMessage.reasoning_content).toBe('');
    // Gemini confirmed it was done on its own — the round-cap note shouldn't be added.
    expect(synthesisBody.messages.some((m) => m.role === 'system' && m.content.includes('Nota interna'))).toBe(
      false
    );
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
    expect(extractStatuses(text)).toEqual(['thinking']);
  });

  it('sends gemini-3.1-flash-lite with minimal reasoning effort in round 1', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('gemini-3.1-flash-lite');
    expect(body.reasoning_effort).toBe('minimal');
  });

  it('executes a requested tool call and streams the follow-up answer', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
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

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(executeBggTool).toHaveBeenCalledWith('bgg_search_game', { query: 'Wingspan' }, 'bgg-token');
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');
    expect(extractStatuses(text)).toEqual(['thinking', 'searching', 'thinking', 'writing']);

    const synthesisBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    const toolMessage = synthesisBody.messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toBe(JSON.stringify({ result: [{ id: 1, name: 'Wingspan' }] }));
    expect(synthesisBody.tools).toBeUndefined();
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
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    expect(executeBggTool).toHaveBeenCalledTimes(3);
  });

  it('passes a tool execution error through as the tool message content without aborting', async () => {
    executeBggTool.mockResolvedValue({ error: 'BGG unavailable' });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    const synthesisBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    const toolMessage = synthesisBody.messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toBe(JSON.stringify({ error: 'BGG unavailable' }));
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('caps tool-calling at 2 rounds and tells the synthesis model no more lookups are available', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"x"}' }]))
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_2', name: 'bgg_search_game', arguments: '{"query":"y"}' }]))
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    // Two Gemini tool rounds + one DeepSeek synthesis call — never a third Gemini round.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe(GEMINI_URL);
    expect(mockFetch.mock.calls[1][0]).toBe(GEMINI_URL);
    expect(mockFetch.mock.calls[2][0]).toBe(DEEPSEEK_URL);
    expect(executeBggTool).toHaveBeenCalledTimes(2);
    expect(extractStatuses(text)).toEqual(['thinking', 'searching', 'thinking', 'searching', 'writing']);

    const synthesisBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    const note = synthesisBody.messages[synthesisBody.messages.length - 1];
    expect(note.role).toBe('system');
    expect(note.content).toContain('Nota interna');
  });

  it('executes the tool with empty args when the model sends malformed arguments JSON', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{bad json' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    await readAllText(response);

    expect(executeBggTool).toHaveBeenCalledWith('bgg_search_game', {}, 'bgg-token');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries round 2 once and uses the clean retry when the follow-up answer leaks DSML', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      );
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest());
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(text).not.toContain('DSML');
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');
  });

  it('falls back to a friendly message when the follow-up answer leaks DSML on both attempts', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(dsmlLeakSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest(), 'es');
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(text).not.toContain('DSML');
    expect(text).toContain('Tuve un problema');
  });

  it('falls back to an English message when language is "en"', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(dsmlLeakSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'what expansion should I buy?' }], env, fakeRequest(), 'en');
    const text = await readAllText(response);

    expect(text).toContain('I ran into a problem');
  });

  it('retries round 1 once and uses the clean retry when the stream is cut short with no finish_reason', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(incompleteStreamSSE())
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(text).toContain('data: {"token":"Hola"}');
  });

  it('falls back to a friendly message when round 1 is cut short on both attempts', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(incompleteStreamSSE())
      .mockResolvedValueOnce(incompleteStreamSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest(), 'es');
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(text).toContain('Tuve un problema');
  });

  it('retries round 2 once and uses the clean retry when the stream is cut short with no finish_reason', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(incompleteStreamSSE())
      .mockResolvedValueOnce(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      );
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest());
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');
  });

  it('writes an error frame into the stream when a round fails with a non-retryable error', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(fakeSSEResponse([], { ok: false, status: 500 }));
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    expect(text).toContain('"error":"Gemini API error: 500');
    expect(text).toContain('data: [DONE]');
  });

});

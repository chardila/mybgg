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

// Mirrors gemini-3.1-flash-lite's real streaming shape (verified live against the
// API): each tool call arrives in its own separate delta chunk with NO `index`
// field on the tool-call item, and the final chunk reports finish_reason "stop"
// (never "tool_calls") even though tool calls were sent earlier in the stream.
function geminiStyleToolCallSSE(toolCalls) {
  return fakeSSEResponse([
    ...toolCalls.map((tc) =>
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } },
              ],
            },
          },
        ],
      })
    ),
    JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }] }),
  ]);
}

// gemini-3.1-flash-lite's real streaming shape also attaches an
// `extra_content.google.thought_signature` field on each tool-call item.
// Gemini's next round rejects a tool_calls history turn that's missing this
// signature ("Function call is missing a thought_signature"), so it must
// round-trip through parseDeepSeekStream and toolCallsAssistantMessage.
function geminiStyleToolCallSSEWithSignature(toolCalls) {
  return fakeSSEResponse([
    ...toolCalls.map((tc) =>
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                  extra_content: tc.extra_content,
                },
              ],
            },
          },
        ],
      })
    ),
    JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }] }),
  ]);
}

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
    // DeepSeek must never see tool-call machinery (that's what makes it leak
    // DSML) — the exchange arrives flattened as one plain system message.
    expect(synthesisBody.messages.some((m) => m.tool_calls)).toBe(false);
    expect(synthesisBody.messages.some((m) => m.role === 'tool')).toBe(false);
    const flattened = synthesisBody.messages[synthesisBody.messages.length - 1];
    expect(flattened.role).toBe('system');
    expect(flattened.content).toContain('Datos ya obtenidos');
    expect(flattened.content).toContain('bgg_search_game');
    expect(flattened.content).toContain('Wingspan');
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
    const flattened = synthesisBody.messages[synthesisBody.messages.length - 1];
    expect(flattened.role).toBe('system');
    expect(flattened.content).toContain(JSON.stringify({ result: [{ id: 1, name: 'Wingspan' }] }));
    expect(synthesisBody.tools).toBeUndefined();
  });

  it('executes at most 4 tool calls per round', async () => {
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

    expect(executeBggTool).toHaveBeenCalledTimes(4);
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
    const flattened = synthesisBody.messages[synthesisBody.messages.length - 1];
    expect(flattened.content).toContain(JSON.stringify({ error: 'BGG unavailable' }));
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('caps tool-calling at 3 rounds and hands DeepSeek the flattened no-more-lookups context', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"x"}' }]))
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_2', name: 'bgg_search_game', arguments: '{"query":"y"}' }]))
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_3', name: 'bgg_search_game', arguments: '{"query":"z"}' }]))
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    // Three Gemini tool rounds + one DeepSeek synthesis call — never a fourth
    // Gemini tool round, and DeepSeek stays the synthesizer (it does the
    // careful catalog cross-checks; Gemini only rescues if it fails twice).
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[0][0]).toBe(GEMINI_URL);
    expect(mockFetch.mock.calls[1][0]).toBe(GEMINI_URL);
    expect(mockFetch.mock.calls[2][0]).toBe(GEMINI_URL);
    expect(mockFetch.mock.calls[3][0]).toBe(DEEPSEEK_URL);
    expect(executeBggTool).toHaveBeenCalledTimes(3);
    expect(extractStatuses(text)).toEqual([
      'thinking',
      'searching',
      'thinking',
      'searching',
      'thinking',
      'searching',
      'writing',
    ]);

    const synthesisBody = JSON.parse(mockFetch.mock.calls[3][1].body);
    const flattened = synthesisBody.messages[synthesisBody.messages.length - 1];
    expect(flattened.role).toBe('system');
    expect(flattened.content).toContain('No es posible hacer más búsquedas');
    expect(synthesisBody.messages.some((m) => m.tool_calls || m.role === 'tool')).toBe(false);
  });

  it('rescues a cap-hit DeepSeek double-leak with a Gemini synthesis at answer-writing effort', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"x"}' }]))
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_2', name: 'bgg_search_game', arguments: '{"query":"y"}' }]))
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_3', name: 'bgg_search_game', arguments: '{"query":"z"}' }]))
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'hola' }], env, fakeRequest());
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(mockFetch.mock.calls[3][0]).toBe(DEEPSEEK_URL);
    expect(mockFetch.mock.calls[4][0]).toBe(DEEPSEEK_URL);
    expect(mockFetch.mock.calls[5][0]).toBe(GEMINI_URL);
    expect(text).not.toContain('DSML');
    expect(text).toContain('data: {"token":"Hola"}');

    const rescueBody = JSON.parse(mockFetch.mock.calls[5][1].body);
    // Tools stay declared so the tool_calls turns in history validate.
    expect(rescueBody.tools).toBeDefined();
    // The rescue writes the final answer: it needs answer-writing effort,
    // not the minimal tool-routing config.
    expect(rescueBody.model).toBe('gemini-3.1-flash-lite');
    expect(rescueBody.reasoning_effort).toBe('medium');
    const note = rescueBody.messages[rescueBody.messages.length - 1];
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

  it('rescues with a Gemini synthesis (with the note appended) when the follow-up answer leaks DSML on both attempts', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      );
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest(), 'es');
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(mockFetch.mock.calls[2][0]).toBe(DEEPSEEK_URL);
    expect(mockFetch.mock.calls[3][0]).toBe(DEEPSEEK_URL);
    expect(mockFetch.mock.calls[4][0]).toBe(GEMINI_URL);
    expect(text).not.toContain('DSML');
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');

    const rescueBody = JSON.parse(mockFetch.mock.calls[4][1].body);
    const note = rescueBody.messages[rescueBody.messages.length - 1];
    expect(note.role).toBe('system');
    expect(note.content).toContain('Nota interna');
  });

  it('falls back to a friendly message when DeepSeek leaks DSML twice and the Gemini rescue also fails twice', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(incompleteStreamSSE())
      .mockResolvedValueOnce(incompleteStreamSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest(), 'es');
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(6);
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
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(incompleteStreamSSE())
      .mockResolvedValueOnce(incompleteStreamSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: 'what expansion should I buy?' }], env, fakeRequest(), 'en');
    const text = await readAllText(response);

    expect(text).toContain('I ran into a problem');
  });

  it('counts a Gemini rescue that still requests a tool call as a failure', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_1', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }]))
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(dsmlLeakSSE())
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_x', name: 'bgg_search_game', arguments: '{"query":"z"}' }]))
      .mockResolvedValueOnce(toolCallSSE([{ id: 'call_y', name: 'bgg_search_game', arguments: '{"query":"z"}' }]));
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion([{ role: 'user', content: '¿qué expansión compro?' }], env, fakeRequest(), 'es');
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(6);
    // The rescue's tool calls must never execute — only the original round's.
    expect(executeBggTool).toHaveBeenCalledTimes(1);
    expect(text).toContain('Tuve un problema');
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

  it('executes a Gemini-3.1-style tool call (finish_reason "stop", no index) and streams the follow-up answer', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        geminiStyleToolCallSSE([{ id: 'HdJfXZaS', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' }])
      )
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      );
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion(
      [{ role: 'user', content: '¿qué expansiones tiene Wingspan?' }],
      env,
      fakeRequest()
    );
    const text = await readAllText(response);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(executeBggTool).toHaveBeenCalledWith('bgg_search_game', { query: 'Wingspan' }, 'bgg-token');
    expect(mockFetch.mock.calls[2][0]).toBe(DEEPSEEK_URL);
    const synthesisBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    const flattened = synthesisBody.messages[synthesisBody.messages.length - 1];
    expect(flattened.content).toContain(JSON.stringify({ result: [{ id: 1, name: 'Wingspan' }] }));
    expect(text).toContain('data: {"token":"Encontré Wingspan."}');
  });

  it('executes two Gemini-3.1-style parallel tool calls (each in its own chunk, no index) without corrupting arguments', async () => {
    executeBggTool.mockResolvedValue({ result: [] });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        geminiStyleToolCallSSE([
          { id: 'lNwflj2K', name: 'bgg_search_game', arguments: '{"query":"Wingspan"}' },
          { id: 'S2JyKBRj', name: 'bgg_search_game', arguments: '{"query":"Terraforming Mars"}' },
        ])
      )
      .mockResolvedValueOnce(toolRoundDoneSSE())
      .mockResolvedValueOnce(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion(
      [{ role: 'user', content: '¿qué me contás de Wingspan y de Terraforming Mars?' }],
      env,
      fakeRequest()
    );
    await readAllText(response);

    expect(executeBggTool).toHaveBeenCalledTimes(2);
    expect(executeBggTool).toHaveBeenNthCalledWith(1, 'bgg_search_game', { query: 'Wingspan' }, 'bgg-token');
    expect(executeBggTool).toHaveBeenNthCalledWith(2, 'bgg_search_game', { query: 'Terraforming Mars' }, 'bgg-token');
  });

  it('preserves the thought_signature (extra_content) on a Gemini tool call across the round-trip into the next Gemini call', async () => {
    executeBggTool.mockResolvedValue({ result: [{ id: 1, name: 'Wingspan' }] });
    const signature = {
      google: {
        thought_signature:
          'EjQKMgERTTIP2ZcVzoljqnmkzvkTJjzZF1oiRzvTPngpYeY5AQxsEo8Yk6SdS88/frUdQEE+',
      },
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        geminiStyleToolCallSSEWithSignature([
          {
            id: 'HdJfXZaS',
            name: 'bgg_search_game',
            arguments: '{"query":"Wingspan"}',
            extra_content: signature,
          },
        ])
      )
      .mockResolvedValueOnce(noToolCallSSE())
      .mockResolvedValueOnce(
        fakeSSEResponse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Encontré Wingspan.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ])
      );
    vi.stubGlobal('fetch', mockFetch);

    const response = await runChatCompletion(
      [{ role: 'user', content: '¿qué expansiones tiene Wingspan?' }],
      env,
      fakeRequest()
    );
    await readAllText(response);

    // Second fetch call is round 2's Gemini call — its request body carries
    // the round-1 tool call back as history, and must include the signature.
    expect(mockFetch.mock.calls[1][0]).toBe(GEMINI_URL);
    const round2Body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const assistantMessage = round2Body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMessage.tool_calls[0].extra_content).toEqual(signature);
  });

  it('does not add an extra_content key when the tool call had none (DeepSeek-style/gemini-2.5-style)', async () => {
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

    // The synthesis body no longer carries tool_calls (flattened for
    // DeepSeek), so the guard applies to round 2's Gemini history instead.
    const round2Body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const assistantMessage = round2Body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect('extra_content' in assistantMessage.tool_calls[0]).toBe(false);
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

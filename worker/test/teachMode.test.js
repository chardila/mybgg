import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleChat } from '../src/index.js';
import { fakeSSEResponse, readAllText } from './sseHelpers.js';

function createFakeWiki(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

function createEnv(wikiSeed) {
  return {
    WIKI: createFakeWiki(wikiSeed),
    DEEPSEEK_API_KEY: 'key123',
    GEMINI_API_KEY: 'test-gemini-key',
    BGG_TOKEN: 'bgg-token',
  };
}

function fakeChatRequest(body) {
  return new Request('https://example.com/api/chat', {
    method: 'POST',
    headers: { Origin: 'https://bgg.cardila.com', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const wikiSeed = {
  'games/pandemic-2008/index': '---\nname: "Pandemic"\nedition: "2008"\n---\nOverview.',
  'games/pandemic-2008/rules': 'Rules text.',
  'games/pandemic-2008/teaching': 'Explicación de 5 minutos de prueba.',
  'games/pandemic-2008/faq': 'FAQ text.',
  'games/pandemic-2008/glossary': 'Glossary text.',
};

const noToolCallSSE = () =>
  fakeSSEResponse([
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hola' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]);

describe('handleChat mode="teach"', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects the teach system prompt and includes the teaching guide in context', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const request = fakeChatRequest({
      message: 'Enséñame a jugar Pandemic desde cero.',
      history: [],
      mode: 'teach',
      game: 'pandemic-2008',
      expansions: [],
      language: 'es',
    });

    const response = await handleChat(request, createEnv(wikiSeed));
    await readAllText(response);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMessage = requestBody.messages.find((m) => m.role === 'system');
    expect(systemMessage.content).toContain('tutor paciente');
    expect(systemMessage.content).toContain('PROACTIVA');
    expect(systemMessage.content).not.toContain('Eres un experto en');
    expect(systemMessage.content).toContain('Explicación de 5 minutos de prueba.');
  });

  it('still selects the deep_dive system prompt when mode is "deep_dive" (regression)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noToolCallSSE());
    vi.stubGlobal('fetch', mockFetch);

    const request = fakeChatRequest({
      message: '¿Cómo se anota la ciudad?',
      history: [],
      mode: 'deep_dive',
      game: 'pandemic-2008',
      expansions: [],
      language: 'es',
    });

    const response = await handleChat(request, createEnv(wikiSeed));
    await readAllText(response);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMessage = requestBody.messages.find((m) => m.role === 'system');
    expect(systemMessage.content).toContain('Eres un experto en');
    expect(systemMessage.content).not.toContain('tutor paciente');
  });

  it('returns an error when mode is "teach" but no game slug is given', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const request = fakeChatRequest({ message: 'hola', history: [], mode: 'teach', game: null });
    const response = await handleChat(request, createEnv({}));
    const text = await readAllText(response);

    expect(text).toContain('Invalid mode');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

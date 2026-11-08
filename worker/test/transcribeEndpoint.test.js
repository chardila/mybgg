import { describe, it, expect, vi } from 'vitest';
import { handleTranscribe, bytesToBase64, MAX_AUDIO_BYTES } from '../src/transcribe.js';

describe('bytesToBase64', () => {
  it('matches btoa for small input and handles inputs larger than one chunk', () => {
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe(btoa('Hi'));
    const big = new Uint8Array(100000).map((_, i) => i % 251);
    const expected = btoa(Array.from(big, (b) => String.fromCharCode(b)).join(''));
    expect(bytesToBase64(big)).toBe(expected);
  });
});

const cors = () => ({ 'Access-Control-Allow-Origin': 'https://bgg.cardila.com' });

function mapStore(prefill = {}) {
  const m = new Map(Object.entries(prefill));
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}

function req({ body = new Uint8Array([1, 2, 3, 4]), query = '', ip = '2.2.2.2' } = {}) {
  return new Request(`https://x.test/api/transcribe${query}`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body,
  });
}

const okAI = (text = ' hola ') => ({ run: vi.fn(async () => ({ text })) });
const env = (extra = {}) => ({ AI: okAI(), WIKI: mapStore(), ...extra });

describe('handleTranscribe', () => {
  it('returns 400 empty_audio for an empty body', async () => {
    const res = await handleTranscribe(req({ body: new Uint8Array(0) }), env(), cors);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('empty_audio');
  });

  it('returns 413 audio_too_large without calling the AI', async () => {
    const e = env();
    const res = await handleTranscribe(req({ body: new Uint8Array(MAX_AUDIO_BYTES + 1) }), e, cors);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('audio_too_large');
    expect(e.AI.run).not.toHaveBeenCalled();
  });

  it('returns 429 rate_limited when the voice counter for this ip is at the limit', async () => {
    const windowStart = Math.floor(Date.now() / 60000);
    const store = mapStore({ [`ratelimit:voice:2.2.2.2:${windowStart}`]: '10' });
    const e = env({ WIKI: store });
    const res = await handleTranscribe(req(), e, cors);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate_limited');
    expect(e.AI.run).not.toHaveBeenCalled();
  });

  it('calls Whisper with Spanish forced and the prompt, and returns trimmed text with timing', async () => {
    const e = env();
    const res = await handleTranscribe(req({ query: '?prompt=Pandemic%20Legacy' }), e, cors);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('hola');
    expect(typeof body.ms).toBe('number');
    expect(e.AI.run).toHaveBeenCalledWith('@cf/openai/whisper-large-v3-turbo', {
      audio: btoa('\x01\x02\x03\x04'),
      language: 'es',
      task: 'transcribe',
      initial_prompt: 'Pandemic Legacy',
    });
  });

  it('omits initial_prompt when no prompt is given', async () => {
    const e = env();
    await handleTranscribe(req(), e, cors);
    expect(e.AI.run.mock.calls[0][1]).not.toHaveProperty('initial_prompt');
  });

  it('truncates a prompt longer than 400 characters', async () => {
    const e = env();
    await handleTranscribe(req({ query: `?prompt=${'a'.repeat(500)}` }), e, cors);
    expect(e.AI.run.mock.calls[0][1].initial_prompt).toHaveLength(400);
  });

  it('maps the daily free-quota error (3036) to 503 voice_unavailable', async () => {
    const AI = { run: vi.fn(async () => { throw new Error('3036: You have used up your daily free allocation of 10,000 neurons'); }) };
    const res = await handleTranscribe(req(), env({ AI }), cors);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('voice_unavailable');
  });

  it('maps any other AI failure to 502 transcription_failed without leaking the message', async () => {
    const AI = { run: vi.fn(async () => { throw new Error('decode failed'); }) };
    const res = await handleTranscribe(req(), env({ AI }), cors);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('transcription_failed');
    expect(text).not.toContain('decode failed');
  });

  it('rejects a declared Content-Length of 0 before touching KV', async () => {
    const store = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const request = new Request('https://x.test/api/transcribe', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '2.2.2.2', 'Content-Length': '0' },
      body: new Uint8Array(0),
    });
    const res = await handleTranscribe(request, env({ WIKI: store }), cors);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('empty_audio');
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('stops reading a chunked body without Content-Length once it exceeds the cap', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(300 * 1024);
    const body = new ReadableStream({
      pull(controller) {
        if (pulled >= 10) return controller.close();
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const request = new Request('https://x.test/api/transcribe', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '2.2.2.2' },
      body,
      duplex: 'half',
    });
    const e = env();
    const res = await handleTranscribe(request, e, cors);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('audio_too_large');
    expect(pulled).toBeLessThan(10);
    expect(e.AI.run).not.toHaveBeenCalled();
  });

  it('still transcribes when the KV rate-limit store is failing (fail open)', async () => {
    const store = {
      get: vi.fn(async () => { throw new Error('KV daily limit exceeded'); }),
      put: vi.fn(async () => { throw new Error('KV daily limit exceeded'); }),
    };
    const e = env({ WIKI: store });
    const res = await handleTranscribe(req(), e, cors);
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe('hola');
    expect(e.AI.run).toHaveBeenCalledTimes(1);
  });

  it('returns 503 voice_unavailable when the AI binding is missing', async () => {
    const res = await handleTranscribe(req(), { WIKI: mapStore() }, cors);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('voice_unavailable');
  });
});

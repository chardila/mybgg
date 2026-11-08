import { describe, it, expect, vi } from 'vitest';
import { handleTranscribeLab, bytesToBase64 } from '../src/voiceLab.js';

const cors = () => ({ 'Access-Control-Allow-Origin': 'https://bgg.cardila.com' });

function req({ key, body = new Uint8Array([1, 2, 3, 4]), query = '' } = {}) {
  const headers = {};
  if (key !== undefined) headers['X-Lab-Key'] = key;
  return new Request(`https://x.test/api/lab/transcribe${query}`, { method: 'POST', headers, body });
}

const okAI = (text = 'hola mundo') => ({ run: vi.fn(async () => ({ text: ` ${text} `, transcription_info: { duration: 2.5, language: 'es' } })) });

describe('bytesToBase64', () => {
  it('matches btoa for small input and handles inputs larger than one chunk', () => {
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe(btoa('Hi'));
    const big = new Uint8Array(100000).map((_, i) => i % 251);
    const expected = btoa(Array.from(big, (b) => String.fromCharCode(b)).join(''));
    expect(bytesToBase64(big)).toBe(expected);
  });
});

describe('handleTranscribeLab', () => {
  it('is disabled when LAB_KEY is not configured', async () => {
    const res = await handleTranscribeLab(req({ key: 'k' }), { AI: okAI() }, cors);
    expect(res.status).toBe(503);
  });

  it('rejects a missing or wrong key without calling the AI', async () => {
    const AI = okAI();
    expect((await handleTranscribeLab(req(), { LAB_KEY: 'secret', AI }, cors)).status).toBe(401);
    expect((await handleTranscribeLab(req({ key: 'nope' }), { LAB_KEY: 'secret', AI }, cors)).status).toBe(401);
    expect(AI.run).not.toHaveBeenCalled();
  });

  it('rejects empty and oversized audio without calling the AI', async () => {
    const AI = okAI();
    const env = { LAB_KEY: 'secret', AI };
    expect((await handleTranscribeLab(req({ key: 'secret', body: new Uint8Array(0) }), env, cors)).status).toBe(400);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    expect((await handleTranscribeLab(req({ key: 'secret', body: big }), env, cors)).status).toBe(413);
    expect(AI.run).not.toHaveBeenCalled();
  });

  it('transcribes with Spanish forced, passes the prompt, and trims the text', async () => {
    const AI = okAI('mueve el meeple');
    const res = await handleTranscribeLab(
      req({ key: 'secret', query: '?prompt=Pandemic%20Legacy' }),
      { LAB_KEY: 'secret', AI },
      cors,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('mueve el meeple');
    expect(body.duration).toBe(2.5);
    const [model, input] = AI.run.mock.calls[0];
    expect(model).toBe('@cf/openai/whisper-large-v3-turbo');
    expect(input.language).toBe('es');
    expect(input.initial_prompt).toBe('Pandemic Legacy');
    expect(input.audio).toBe(btoa('\x01\x02\x03\x04'));
  });

  it('omits initial_prompt when none is given', async () => {
    const AI = okAI();
    await handleTranscribeLab(req({ key: 'secret' }), { LAB_KEY: 'secret', AI }, cors);
    expect(AI.run.mock.calls[0][1]).not.toHaveProperty('initial_prompt');
  });

  it('turns an AI failure (e.g. daily free quota) into a 502 with the message', async () => {
    const AI = { run: vi.fn(async () => { throw new Error('3036: used up your daily free allocation'); }) };
    const res = await handleTranscribeLab(req({ key: 'secret' }), { LAB_KEY: 'secret', AI }, cors);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('3036');
  });
});

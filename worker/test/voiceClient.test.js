import { describe, it, expect, vi } from 'vitest';
import {
  MAX_SECONDS,
  MIN_AUDIO_BYTES,
  VoiceUnavailableError,
  pickMime,
  buildVocabularyPrompt,
  transcribeBlob,
} from '../../voice-input.js';

const blobOf = (type = 'audio/webm;codecs=opus') => ({ type, size: 5000 });

function fakeFetch(...responses) {
  const queue = [...responses];
  const fn = vi.fn(async () => {
    const { status, body } = queue.shift();
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
  return fn;
}

describe('constants', () => {
  it('pins the recording limits', () => {
    expect(MAX_SECONDS).toBe(30);
    expect(MIN_AUDIO_BYTES).toBe(1000);
  });
});

describe('pickMime', () => {
  it('returns the first supported type in preference order', () => {
    const MR = { isTypeSupported: (m) => m === 'audio/mp4' || m === 'audio/webm' };
    expect(pickMime(MR)).toBe('audio/mp4');
  });

  it('returns an empty string when none is supported or MediaRecorder is missing', () => {
    expect(pickMime({ isTypeSupported: () => false })).toBe('');
    expect(pickMime(undefined)).toBe('');
  });
});

describe('buildVocabularyPrompt', () => {
  it('returns an empty string without a game', () => {
    expect(buildVocabularyPrompt(null)).toBe('');
    expect(buildVocabularyPrompt('')).toBe('');
  });

  it('wraps the game name', () => {
    expect(buildVocabularyPrompt('Azul')).toBe('Juego de mesa: Azul.');
  });

  it('caps the prompt at 400 characters', () => {
    expect(buildVocabularyPrompt('x'.repeat(500)).length).toBeLessThanOrEqual(400);
  });
});

describe('transcribeBlob', () => {
  it('posts the blob with its content type and returns trimmed text', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { text: ' hola ' } });
    const blob = blobOf();
    const text = await transcribeBlob(blob, { prompt: 'Juego de mesa: Azul.', fetchImpl });
    expect(text).toBe('hola');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/transcribe?prompt=Juego%20de%20mesa%3A%20Azul.');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('audio/webm;codecs=opus');
    expect(init.body).toBe(blob);
  });

  it('omits the query string when there is no prompt and honors workerUrl', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { text: 'ok' } });
    await transcribeBlob(blobOf(), { workerUrl: 'https://w.test', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://w.test/api/transcribe');
  });

  it('throws VoiceUnavailableError on 503', async () => {
    const fetchImpl = fakeFetch({ status: 503, body: { error: 'voice_unavailable' } });
    await expect(transcribeBlob(blobOf(), { fetchImpl })).rejects.toBeInstanceOf(VoiceUnavailableError);
  });

  it('retries once as WAV on 502 and sends the converted blob', async () => {
    const fetchImpl = fakeFetch(
      { status: 502, body: { error: 'transcription_failed' } },
      { status: 200, body: { text: 'ya' } },
    );
    const wav = blobOf('audio/wav');
    const convert = vi.fn(async () => wav);
    const text = await transcribeBlob(blobOf('audio/mp4'), { fetchImpl, convert });
    expect(text).toBe('ya');
    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[1][1].body).toBe(wav);
    expect(fetchImpl.mock.calls[1][1].headers['Content-Type']).toBe('audio/wav');
  });

  it('does not retry a 502 when the blob is already WAV', async () => {
    const fetchImpl = fakeFetch({ status: 502, body: { error: 'transcription_failed' } });
    const convert = vi.fn();
    await expect(transcribeBlob(blobOf('audio/wav'), { fetchImpl, convert })).rejects.toThrow('transcription_failed');
    expect(convert).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws an Error carrying the server error code on other failures', async () => {
    const fetchImpl = fakeFetch({ status: 429, body: { error: 'rate_limited' } });
    const err = await transcribeBlob(blobOf(), { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(VoiceUnavailableError);
    expect(err.message).toBe('rate_limited');
  });
});

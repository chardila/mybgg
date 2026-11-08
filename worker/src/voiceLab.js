// THROWAWAY SPIKE: voice-transcription lab endpoint.
// Gated by a shared secret (env.LAB_KEY) and capped by audio size so a public
// Worker can't be abused. Uses Workers AI (free plan: hard daily cap, no bill).

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // ~60s of compressed audio / ~60s of 16 kHz mono WAV
const MAX_PROMPT_CHARS = 400;

import { bytesToBase64 } from './transcribe.js';
export { bytesToBase64 };

function json(request, getCorsHeaders, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
  });
}

export async function handleTranscribeLab(request, env, getCorsHeaders) {
  const reply = (body, status) => json(request, getCorsHeaders, body, status);

  if (!env.LAB_KEY) return reply({ error: 'lab disabled' }, 503);
  if (request.headers.get('X-Lab-Key') !== env.LAB_KEY) {
    return reply({ error: 'unauthorized' }, 401);
  }
  if (!env.AI) return reply({ error: 'AI binding missing' }, 503);

  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > MAX_AUDIO_BYTES) return reply({ error: 'audio too large' }, 413);

  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.length === 0) return reply({ error: 'empty audio' }, 400);
  if (audio.length > MAX_AUDIO_BYTES) return reply({ error: 'audio too large' }, 413);

  const url = new URL(request.url);
  const prompt = (url.searchParams.get('prompt') || '').slice(0, MAX_PROMPT_CHARS);

  const input = { audio: bytesToBase64(audio), language: 'es', task: 'transcribe' };
  if (prompt) input.initial_prompt = prompt;

  const started = Date.now();
  try {
    const out = await env.AI.run(MODEL, input);
    return reply({
      text: (out.text || '').trim(),
      duration: out.transcription_info?.duration ?? null,
      language: out.transcription_info?.language ?? null,
      ms: Date.now() - started,
      bytes: audio.length,
    });
  } catch (e) {
    return reply({ error: String(e && e.message ? e.message : e), ms: Date.now() - started }, 502);
  }
}

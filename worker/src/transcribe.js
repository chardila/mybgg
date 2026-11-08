import { checkRateLimit } from './rateLimiter.js';

const MODEL = '@cf/openai/whisper-large-v3-turbo';
export const MAX_AUDIO_BYTES = 1048576; // ~30 s of 16 kHz mono WAV; far more of compressed audio
const MAX_PROMPT_CHARS = 400;
const VOICE_RATE_LIMIT = 10; // requests per minute per IP
const QUOTA_ERROR = /\b3036\b|daily free allocation/i;

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Read the body but give up as soon as it passes `max` bytes (null), so a chunked upload
// without Content-Length can't make the Worker buffer an arbitrarily large body.
async function readCapped(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

export async function handleTranscribe(request, env, getCorsHeaders) {
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
    });

  if (!env.AI) return reply({ error: 'voice_unavailable' }, 503);

  const lengthHeader = request.headers.get('Content-Length');
  const declared = parseInt(lengthHeader || '0', 10);
  if (declared > MAX_AUDIO_BYTES) return reply({ error: 'audio_too_large' }, 413);
  if (lengthHeader !== null && declared === 0) return reply({ error: 'empty_audio' }, 400);

  // The Workers AI free quota is the real spending cap, so if KV (the limiter's store) is down
  // we let the request through rather than killing voice for the rest of the day.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { allowed } = await checkRateLimit({ store: env.WIKI, ip, limit: VOICE_RATE_LIMIT, prefix: 'voice' });
    if (!allowed) return reply({ error: 'rate_limited' }, 429);
  } catch {
    // fail open
  }

  const audio = await readCapped(request, MAX_AUDIO_BYTES);
  if (audio === null) return reply({ error: 'audio_too_large' }, 413);
  if (audio.length === 0) return reply({ error: 'empty_audio' }, 400);

  const prompt = (new URL(request.url).searchParams.get('prompt') || '').slice(0, MAX_PROMPT_CHARS);
  const input = { audio: bytesToBase64(audio), language: 'es', task: 'transcribe' };
  if (prompt) input.initial_prompt = prompt;

  const started = Date.now();
  try {
    const out = await env.AI.run(MODEL, input);
    return reply({ text: (out.text || '').trim(), ms: Date.now() - started });
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    if (QUOTA_ERROR.test(message)) return reply({ error: 'voice_unavailable' }, 503);
    return reply({ error: 'transcription_failed' }, 502);
  }
}

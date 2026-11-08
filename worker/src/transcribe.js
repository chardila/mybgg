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

export async function handleTranscribe(request, env, getCorsHeaders) {
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
    });

  if (!env.AI) return reply({ error: 'voice_unavailable' }, 503);

  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > MAX_AUDIO_BYTES) return reply({ error: 'audio_too_large' }, 413);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { allowed } = await checkRateLimit({ store: env.WIKI, ip, limit: VOICE_RATE_LIMIT, prefix: 'voice' });
  if (!allowed) return reply({ error: 'rate_limited' }, 429);

  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.length === 0) return reply({ error: 'empty_audio' }, 400);
  if (audio.length > MAX_AUDIO_BYTES) return reply({ error: 'audio_too_large' }, 413);

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

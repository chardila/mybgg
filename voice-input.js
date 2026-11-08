// Voice input for the chat: record with MediaRecorder, transcribe via the Worker (/api/transcribe).
// ES module; the pure parts are unit-tested from worker/test/.

export const MAX_SECONDS = 30;
export const MIN_AUDIO_BYTES = 1000;
const MAX_PROMPT_CHARS = 400;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];

export class VoiceUnavailableError extends Error {
  constructor(message = 'voice_unavailable') {
    super(message);
    this.name = 'VoiceUnavailableError';
  }
}

export function pickMime(MediaRecorderClass) {
  if (!MediaRecorderClass || typeof MediaRecorderClass.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((m) => MediaRecorderClass.isTypeSupported(m)) || '';
}

export function buildVocabularyPrompt(gameName) {
  if (!gameName) return '';
  return `Juego de mesa: ${gameName}.`.slice(0, MAX_PROMPT_CHARS);
}

// Browser-only: re-encode any decodable audio as WAV 16 kHz mono 16-bit (Whisper-friendly).
export async function toWav16k(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const length = Math.ceil(decoded.duration * 16000);
    const off = new OfflineAudioContext(1, length, 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  } finally {
    ctx.close();
  }
}

export async function transcribeBlob(blob, opts = {}) {
  const { prompt = '', workerUrl = '', fetchImpl = (...a) => fetch(...a), convert = toWav16k } = opts;
  const url = `${workerUrl}/api/transcribe` + (prompt ? `?prompt=${encodeURIComponent(prompt)}` : '');

  const post = async (b) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': b.type || 'application/octet-stream' }, body: b });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  let { res, data } = await post(blob);
  if (res.status === 502 && blob.type !== 'audio/wav') {
    ({ res, data } = await post(await convert(blob)));
  }
  if (res.status === 503) throw new VoiceUnavailableError();
  if (!res.ok) throw new Error(data.error || 'transcription_failed');
  return String(data.text || '').trim();
}

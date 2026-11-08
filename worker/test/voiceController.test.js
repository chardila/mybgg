import { describe, it, expect, vi } from 'vitest';
import { createHoldToTalk, VoiceUnavailableError } from '../../voice-input.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

const NOTE_SHORT = 'No te escuché, intenta de nuevo.';
const NOTE_FAIL = 'No se pudo transcribir, intenta de nuevo o escribe tu pregunta.';
const NOTE_PERM = 'Permite el micrófono para el sitio en los ajustes de Safari.';

function makeButton() {
  const handlers = {};
  return {
    dataset: {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
    setPointerCapture: () => {},
    fire: (type) => handlers[type]({ pointerId: 1, preventDefault() {} }),
  };
}

function makeRecorderClass(blobBytes = 5000) {
  const instances = [];
  class FakeRecorder {
    static isTypeSupported(m) { return m === 'audio/webm;codecs=opus'; }
    constructor(stream, opts) {
      this.mimeType = opts?.mimeType;
      this.state = 'inactive';
      this.start = vi.fn(() => { this.state = 'recording'; });
      this.stop = vi.fn(() => {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable({ data: new Blob([new Uint8Array(blobBytes)]) });
          this.onstop();
        });
      });
      instances.push(this);
    }
  }
  FakeRecorder.instances = instances;
  return FakeRecorder;
}

function setup({ blobBytes, transcribe, getUserMedia, getPrompt = () => 'Juego de mesa: Azul.' } = {}) {
  const button = makeButton();
  const MediaRecorderClass = makeRecorderClass(blobBytes);
  const timers = [];
  const handlers = { onText: vi.fn(), onNote: vi.fn(), onUnavailable: vi.fn() };
  const deps = {
    getUserMedia: getUserMedia || vi.fn(async () => ({ id: 'stream' })),
    MediaRecorderClass,
    transcribe: transcribe || vi.fn(async () => 'hola'),
    setTimeoutFn: vi.fn((cb, ms) => { timers.push({ cb, ms }); return timers.length; }),
    clearTimeoutFn: vi.fn(),
  };
  const ctl = createHoldToTalk({ button, getPrompt, ...handlers, deps });
  return { button, ctl, deps, timers, MediaRecorderClass, ...handlers };
}

describe('createHoldToTalk', () => {
  it('starts idle', () => {
    const { button } = setup();
    expect(button.dataset.state).toBe('idle');
  });

  it('releasing before the permission prompt resolves leaves nothing recording and sends nothing', async () => {
    let resolveStream;
    const getUserMedia = vi.fn(() => new Promise((r) => { resolveStream = r; }));
    const { button, deps, MediaRecorderClass } = setup({ getUserMedia });
    button.fire('pointerdown');
    button.fire('pointerup');
    resolveStream({ id: 'stream' });
    await flush();
    expect(MediaRecorderClass.instances).toHaveLength(0);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(button.dataset.state).toBe('idle');
  });

  it('a very short recording shows the "no te escuché" note and sends nothing', async () => {
    const { button, deps, onNote } = setup({ blobBytes: 500 });
    button.fire('pointerdown');
    await flush();
    button.fire('pointerup');
    await flush();
    expect(onNote).toHaveBeenCalledWith(NOTE_SHORT);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(button.dataset.state).toBe('idle');
  });

  it('auto-stops at 30 s and transcribes with the current prompt', async () => {
    const { button, deps, timers, MediaRecorderClass } = setup();
    button.fire('pointerdown');
    await flush();
    expect(timers.at(-1).ms).toBe(30000);
    timers.at(-1).cb();
    await flush();
    expect(MediaRecorderClass.instances[0].stop).toHaveBeenCalledTimes(1);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.transcribe.mock.calls[0][1]).toEqual({ prompt: 'Juego de mesa: Azul.' });
  });

  it('delivers the transcription through onText and returns to idle', async () => {
    const { button, onText, onNote } = setup();
    button.fire('pointerdown');
    await flush();
    expect(button.dataset.state).toBe('recording');
    button.fire('pointerup');
    await flush();
    expect(onText).toHaveBeenCalledWith('hola');
    expect(onNote).not.toHaveBeenCalled();
    expect(button.dataset.state).toBe('idle');
  });

  it('an empty transcription shows the "no te escuché" note', async () => {
    const { button, onText, onNote } = setup({ transcribe: vi.fn(async () => '') });
    button.fire('pointerdown');
    await flush();
    button.fire('pointerup');
    await flush();
    expect(onText).not.toHaveBeenCalled();
    expect(onNote).toHaveBeenCalledWith(NOTE_SHORT);
  });

  it('VoiceUnavailableError calls onUnavailable once and shows no error note', async () => {
    const { button, onUnavailable, onNote } = setup({ transcribe: vi.fn(async () => { throw new VoiceUnavailableError(); }) });
    button.fire('pointerdown');
    await flush();
    button.fire('pointerup');
    await flush();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onNote).not.toHaveBeenCalled();
    expect(button.dataset.state).toBe('idle');
  });

  it('any other failure shows the generic note and keeps the mic available', async () => {
    const { button, onUnavailable, onNote } = setup({ transcribe: vi.fn(async () => { throw new Error('rate_limited'); }) });
    button.fire('pointerdown');
    await flush();
    button.fire('pointerup');
    await flush();
    expect(onNote).toHaveBeenCalledWith(NOTE_FAIL);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(button.dataset.state).toBe('idle');
  });

  it('a denied microphone permission shows the Safari settings note', async () => {
    const getUserMedia = vi.fn(async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; });
    const { button, onNote, MediaRecorderClass } = setup({ getUserMedia });
    button.fire('pointerdown');
    await flush();
    expect(onNote).toHaveBeenCalledWith(NOTE_PERM);
    expect(MediaRecorderClass.instances).toHaveLength(0);
    expect(button.dataset.state).toBe('idle');
  });

  it('ignores a second press while recording or transcribing', async () => {
    let finish;
    const transcribe = vi.fn(() => new Promise((r) => { finish = r; }));
    const { button, deps, MediaRecorderClass } = setup({ transcribe });
    button.fire('pointerdown');
    await flush();
    button.fire('pointerdown'); // while recording
    button.fire('pointerup');
    await flush();
    expect(button.dataset.state).toBe('transcribing');
    button.fire('pointerdown'); // while transcribing
    await flush();
    expect(MediaRecorderClass.instances).toHaveLength(1);
    expect(deps.getUserMedia).toHaveBeenCalledTimes(1);
    finish('listo');
    await flush();
    expect(button.dataset.state).toBe('idle');
  });

  it('reuses one microphone stream across presses', async () => {
    const { button, deps } = setup();
    for (let i = 0; i < 2; i++) {
      button.fire('pointerdown');
      await flush();
      button.fire('pointerup');
      await flush();
    }
    expect(deps.getUserMedia).toHaveBeenCalledTimes(1);
  });
});

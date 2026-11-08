import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '../src/rateLimiter.js';

function mapStore() {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, _m: m };
}

describe('checkRateLimit', () => {
  it('allows 20 calls per window with the default prefix and blocks the 21st', async () => {
    const store = mapStore();
    for (let i = 0; i < 20; i++) {
      expect((await checkRateLimit({ store, ip: '1.1.1.1', now: 1000 })).allowed).toBe(true);
    }
    expect((await checkRateLimit({ store, ip: '1.1.1.1', now: 1000 })).allowed).toBe(false);
  });

  it('keeps a separate counter per prefix for the same ip', async () => {
    const store = mapStore();
    for (let i = 0; i < 20; i++) await checkRateLimit({ store, ip: '1.1.1.1', now: 1000 });
    expect((await checkRateLimit({ store, ip: '1.1.1.1', now: 1000 })).allowed).toBe(false);
    expect((await checkRateLimit({ store, ip: '1.1.1.1', now: 1000, prefix: 'voice' })).allowed).toBe(true);
  });

  it('uses the prefix in the KV key', async () => {
    const store = mapStore();
    await checkRateLimit({ store, ip: '9.9.9.9', now: 60000, prefix: 'voice' });
    expect([...store._m.keys()][0]).toBe('ratelimit:voice:9.9.9.9:1');
  });
});

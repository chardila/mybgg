import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '../src/rateLimiter.js';

function createFakeStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    _map: map,
  };
}

describe('checkRateLimit', () => {
  it('allows requests while under the limit', async () => {
    const store = createFakeStore();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      const result = await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks the request that would exceed the limit', async () => {
    const store = createFakeStore();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    }
    const result = await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    expect(result.allowed).toBe(false);
  });

  it('resets after the window elapses', async () => {
    const store = createFakeStore();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    }
    const blocked = await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    expect(blocked.allowed).toBe(false);

    const later = now + 61 * 1000;
    const result = await checkRateLimit({ store, ip: '1.2.3.4', now: later, limit: 20, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
  });

  it('tracks different IPs independently', async () => {
    const store = createFakeStore();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    }
    const blockedFirstIp = await checkRateLimit({ store, ip: '1.2.3.4', now, limit: 20, windowSeconds: 60 });
    expect(blockedFirstIp.allowed).toBe(false);

    const otherIp = await checkRateLimit({ store, ip: '5.6.7.8', now, limit: 20, windowSeconds: 60 });
    expect(otherIp.allowed).toBe(true);
  });

  it('passes expirationTtl of 2x the window to the store', async () => {
    const store = createFakeStore();
    let capturedOpts;
    const spyStore = {
      async get(key) { return store.get(key); },
      async put(key, value, opts) {
        capturedOpts = opts;
        return store.put(key, value, opts);
      },
    };
    await checkRateLimit({ store: spyStore, ip: '1.2.3.4', now: Date.now(), limit: 20, windowSeconds: 60 });
    expect(capturedOpts).toEqual({ expirationTtl: 120 });
  });
});

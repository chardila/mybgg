const DEFAULT_LIMIT = 20;
const DEFAULT_WINDOW_SECONDS = 60;

export async function checkRateLimit({
  store,
  ip,
  now = Date.now(),
  limit = DEFAULT_LIMIT,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
}) {
  const windowStart = Math.floor(now / (windowSeconds * 1000));
  const key = `ratelimit:chat:${ip}:${windowStart}`;

  const current = await store.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= limit) {
    return { allowed: false };
  }

  await store.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
  return { allowed: true };
}

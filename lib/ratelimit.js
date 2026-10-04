// lib/ratelimit.js
// Fixed-window rate limiting per IP per route, backed by lib/store.js.
//
// Two layers are enforced for each route:
//   1. A per-minute window (burst control).
//   2. A per-day window (cost backstop so one IP can't rack up huge bills).
//
// On the in-memory fallback (local dev) this is per-process only; in production
// it relies on Upstash being configured (see lib/store.js).
//
// Usage in a handler (do this BEFORE expensive work — B1-6):
//   import { enforceRateLimit } from '../lib/ratelimit.js';
//   if (await enforceRateLimit(req, res, 'chat')) return; // 429 already sent

import { incr } from './store.js';
import { clientIp, hashIp } from './session.js';

const MINUTE_S = 60;
const DAY_S = 24 * 60 * 60;

// Per-route limits. Generous enough not to block light manual testing.
const LIMITS = {
  chat:       { perMin: 20, perDay: 300 },
  voice:      { perMin: 20, perDay: 300 },
  transcribe: { perMin: 20, perDay: 300 },
  unlock:     { perMin: 5,  perDay: 20 },
};
const DEFAULT = { perMin: 20, perDay: 300 };

// Returns true if the request was rate-limited (and a 429 has been written to
// res). Returns false if the request is allowed to proceed.
export async function enforceRateLimit(req, res, route) {
  const limits = LIMITS[route] || DEFAULT;
  const idHash = hashIp(clientIp(req));

  // Fixed minute window: bucket the current time into a minute slot so the key
  // naturally rotates and the TTL cleans up old buckets.
  const minuteBucket = Math.floor(Date.now() / 1000 / MINUTE_S);
  const minKey = `rl:${route}:m:${idHash}:${minuteBucket}`;
  const dayBucket = Math.floor(Date.now() / 1000 / DAY_S);
  const dayKey = `rl:${route}:d:${idHash}:${dayBucket}`;

  // Increment minute window first (cheaper signal, shorter TTL).
  const minuteCount = await incr(minKey, MINUTE_S);
  if (minuteCount > limits.perMin) {
    const retryAfter = MINUTE_S - (Math.floor(Date.now() / 1000) % MINUTE_S);
    res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
    res.status(429).json({ error: 'rate_limited' });
    return true;
  }

  const dayCount = await incr(dayKey, DAY_S);
  if (dayCount > limits.perDay) {
    const retryAfter = DAY_S - (Math.floor(Date.now() / 1000) % DAY_S);
    res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
    res.status(429).json({ error: 'rate_limited' });
    return true;
  }

  return false;
}

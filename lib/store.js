// lib/store.js
// A tiny key-value store abstraction with two backends:
//
//   1. Upstash Redis (REST) — used when BOTH of these env vars are set:
//        UPSTASH_REDIS_REST_URL
//        UPSTASH_REDIS_REST_TOKEN
//      This is the ONLY durable option and is REQUIRED in production. Serverless
//      functions (Vercel) are stateless and may run on many isolated instances,
//      so anything kept in process memory is NOT shared and NOT durable.
//
//   2. In-process Map fallback — used when Upstash env vars are absent.
//      WARNING: FOR LOCAL DEVELOPMENT ONLY. It is NOT durable across serverless
//      invocations and NOT shared between instances. In production this means
//      the budget / rate-limit would effectively reset whenever a new instance
//      spins up, which defeats the whole point. Production MUST set Upstash.
//
// API (all async):
//   get(key)               -> value (string|number|object) or null
//   set(key, val, ttlSeconds?) -> 'OK'
//   incr(key, ttlSeconds?) -> new integer value (sets TTL on first increment)
//
// Values are JSON-encoded for the Upstash backend so objects round-trip.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

let warnedNoUpstash = false;
function warnDevOnce() {
  if (warnedNoUpstash) return;
  warnedNoUpstash = true;
  // Surface clearly that we are running the non-durable fallback.
  console.warn(
    '[store] UPSTASH_REDIS_REST_* not set — using in-memory store. ' +
    'This is for LOCAL DEV ONLY and is NOT durable in production.'
  );
}

// ---------------------------------------------------------------------------
// Upstash Redis REST backend (uses global fetch; no npm dependency).
// We issue commands via the path-style REST API, e.g.
//   POST {url}/set/{key}/{value}/EX/{ttl}
//   POST {url}/get/{key}
//   POST {url}/incr/{key}
// Responses look like { result: ... }.
// ---------------------------------------------------------------------------
async function upstashCommand(parts) {
  const path = parts.map((p) => encodeURIComponent(String(p))).join('/');
  const resp = await fetch(`${UPSTASH_URL}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`upstash ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.result;
}

async function upstashGet(key) {
  const raw = await upstashCommand(['get', key]);
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function upstashSet(key, val, ttlSeconds) {
  const encoded = JSON.stringify(val);
  const parts = ['set', key, encoded];
  if (ttlSeconds && ttlSeconds > 0) parts.push('EX', Math.ceil(ttlSeconds));
  await upstashCommand(parts);
  return 'OK';
}

async function upstashIncr(key, ttlSeconds) {
  const n = await upstashCommand(['incr', key]);
  // Set the TTL on the first increment (when value becomes 1) so the window
  // expires. If it already existed, we leave the existing TTL alone.
  if (n === 1 && ttlSeconds && ttlSeconds > 0) {
    await upstashCommand(['expire', key, Math.ceil(ttlSeconds)]);
  }
  return Number(n);
}

// ---------------------------------------------------------------------------
// In-memory fallback backend (dev only).
// Stores { value, expiresAt } and lazily evicts on access.
// ---------------------------------------------------------------------------
const mem = new Map();

function memEvictIfExpired(key, entry) {
  if (entry && entry.expiresAt && entry.expiresAt <= Date.now()) {
    mem.delete(key);
    return true;
  }
  return false;
}

async function memGet(key) {
  warnDevOnce();
  const entry = mem.get(key);
  if (!entry) return null;
  if (memEvictIfExpired(key, entry)) return null;
  return entry.value;
}

async function memSet(key, val, ttlSeconds) {
  warnDevOnce();
  const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
  mem.set(key, { value: val, expiresAt });
  return 'OK';
}

async function memIncr(key, ttlSeconds) {
  warnDevOnce();
  const existing = mem.get(key);
  let n;
  if (!existing || memEvictIfExpired(key, existing)) {
    n = 1;
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
    mem.set(key, { value: 1, expiresAt });
  } else {
    n = Number(existing.value) + 1;
    existing.value = n; // preserve original expiry, like Redis INCR
  }
  return n;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function get(key) {
  return useUpstash ? upstashGet(key) : memGet(key);
}

export async function set(key, val, ttlSeconds) {
  return useUpstash ? upstashSet(key, val, ttlSeconds) : memSet(key, val, ttlSeconds);
}

export async function incr(key, ttlSeconds) {
  return useUpstash ? upstashIncr(key, ttlSeconds) : memIncr(key, ttlSeconds);
}

export function isDurable() {
  return useUpstash;
}

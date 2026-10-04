// lib/session.js
// Shared session + cookie + budget logic for all /api handlers.
//
// BUDGET MODEL (single source of truth — keep all handlers consistent):
//   The free allowance is FREE_DURATION_MS of wall-clock time measured from the
//   moment the client's IP was FIRST SEEN by the server. We persist
//   `firstSeenAt` per IP in the durable store (lib/store.js). Therefore:
//
//     freeRemainingMs = FREE_DURATION_MS - (now - firstSeenAt)
//
//   Because the source of truth is keyed on the (hashed) client IP and lives
//   server-side, deleting the `sx_session` cookie does NOT reset the free
//   budget — the IP record persists for IP_BUDGET_TTL_S. (B2-1 / B2-3)
//
//   The signed cookie is still used to carry the session id and PAID status
//   (paid / paidUntil), but it is NOT the source of truth for the free budget.
//
// COOKIE: an HMAC-signed, base64url JSON token: `${data}.${sig}`. We embed an
//   `exp` (ms epoch) and reject expired tokens on verify() to limit replay.

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { cookieSameSite } from './cors.js';
import { get as storeGet, set as storeSet } from './store.js';

// ---- Shared constants (previously duplicated across every handler) ----------
export const COOKIE_NAME = 'sx_session';
export const FREE_DURATION_MS = 3 * 60 * 1000;          // 3 free minutes
export const COOKIE_MAX_AGE_S = 24 * 60 * 60;           // cookie lifetime
const COOKIE_EXP_MS = COOKIE_MAX_AGE_S * 1000;          // token freshness window
// How long we remember an IP's firstSeenAt. Must be >= the free window, and
// generous enough that dropping a cookie won't earn a fresh budget. A day keeps
// it bounded while making the budget effectively non-resettable within a visit.
const IP_BUDGET_TTL_S = 24 * 60 * 60;

// ---- Secret handling --------------------------------------------------------
// Returns the secret, or null if missing/too short. Handlers should call
// ensureConfigured(res) to emit a clean 500 instead of throwing. (B1-4)
export function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) return null;
  return s;
}

// Validate config up front. Returns true if OK; otherwise writes a 500 JSON
// response and returns false. (B1-4)
export function ensureConfigured(res) {
  if (!getSecret()) {
    res.status(500).json({ error: 'server_misconfigured' });
    return false;
  }
  return true;
}

// ---- Cookie sign / verify / parse ------------------------------------------
export function sign(payload) {
  const secret = getSecret();
  if (!secret) throw new Error('SESSION_SECRET missing');
  const withExp = { ...payload, exp: Date.now() + COOKIE_EXP_MS };
  const data = Buffer.from(JSON.stringify(withExp)).toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Verify signature AND freshness. Returns the payload object or null. Never
// throws (caller may still wrap in try/catch defensively). (B1-4, B2-7)
export function verify(token) {
  try {
    const secret = getSecret();
    if (!secret) return null;
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [data, sig] = parts;
    const expected = createHmac('sha256', secret).update(data).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    // Reject expired tokens (replay defense). Tokens minted before `exp` was
    // introduced have no exp and are treated as expired -> re-minted fresh.
    if (!payload || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// ---- Cookie writers ---------------------------------------------------------
export function setSessionCookie(res, session) {
  // Only persist the durable bits in the cookie (no `exp`; sign() adds a fresh one).
  const { exp, ...rest } = session || {};
  const value = sign(rest);
  const cookie = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${cookieSameSite()}`,
    `Max-Age=${COOKIE_MAX_AGE_S}`,
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${cookieSameSite()}`,
    'Max-Age=0',
  ].join('; '));
}

// ---- Identity helpers -------------------------------------------------------
// Best-effort client IP. Locally this comes from x-forwarded-for (may be
// absent) or the socket. On Vercel x-forwarded-for is set.
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Hash the IP so we never store raw IPs in the KV store (privacy) and to get a
// stable, safe key. Salted with SESSION_SECRET so keys aren't trivially
// reversible across deployments.
export function hashIp(ip) {
  const secret = getSecret() || 'no-secret';
  return createHash('sha256').update(`${secret}:${ip}`).digest('hex').slice(0, 32);
}

// Generate a fresh session object (16 random bytes for the id — B2-9).
export function newSession() {
  return {
    id: randomBytes(16).toString('hex'),
    paid: false,
    paidUntil: 0,
  };
}

// ---- Budget: server-side, IP-keyed (THE source of truth) --------------------
// Reads/creates the per-IP firstSeenAt record and returns the budget snapshot.
// `session` (from the verified cookie) only contributes paid status.
//
// Returns: { session, firstSeenAt, freeRemainingMs, paidActive, totalRemainingMs }
export async function loadBudget(req, now = Date.now()) {
  // Cookie -> paid status + session id (NOT free budget).
  const cookies = parseCookies(req.headers.cookie);
  let session = verify(cookies[COOKIE_NAME]);
  if (!session) session = newSession();

  const ip = clientIp(req);
  const key = `budget:${hashIp(ip)}`;

  let firstSeenAt = await storeGet(key);
  if (typeof firstSeenAt !== 'number' || !firstSeenAt) {
    firstSeenAt = now;
    // Persist firstSeenAt. The TTL bounds how long the record lives; refreshing
    // it on each call would let a busy user keep extending the window, so we
    // only set it when the record is first created.
    await storeSet(key, firstSeenAt, IP_BUDGET_TTL_S);
  }

  const elapsed = now - firstSeenAt;
  const freeRemainingMs = Math.max(0, FREE_DURATION_MS - elapsed);
  const paidActive = !!session.paid && session.paidUntil > now;
  const totalRemainingMs = paidActive
    ? Math.max(freeRemainingMs, session.paidUntil - now)
    : freeRemainingMs;

  return { session, firstSeenAt, freeRemainingMs, paidActive, totalRemainingMs };
}

// Read-only budget snapshot WITHOUT creating a record (used by session.js so a
// bare GET /api/session doesn't itself start the clock). Mirrors loadBudget math.
export async function peekBudget(req, now = Date.now()) {
  const cookies = parseCookies(req.headers.cookie);
  let session = verify(cookies[COOKIE_NAME]);
  const hasSession = !!session;
  if (!session) session = newSession();

  const ip = clientIp(req);
  const key = `budget:${hashIp(ip)}`;
  const firstSeenAt = await storeGet(key);

  const seen = typeof firstSeenAt === 'number' && firstSeenAt > 0;
  const elapsed = seen ? now - firstSeenAt : 0;
  const freeRemainingMs = Math.max(0, FREE_DURATION_MS - elapsed);
  const paidActive = !!session.paid && session.paidUntil > now;
  const totalRemainingMs = paidActive
    ? Math.max(freeRemainingMs, session.paidUntil - now)
    : freeRemainingMs;

  return { session, hasSession, seen, firstSeenAt: seen ? firstSeenAt : null, freeRemainingMs, paidActive, totalRemainingMs };
}

// lib/session.js
// Shared session + cookie + budget logic for all /api handlers.
//
// BUDGET MODEL (single source of truth, keep all handlers consistent):
//   1. Per session: SESSION_FREE_MS of wall-clock time from the session's first
//      real use (first chat, voice or transcribe call). The start time lives in
//      the signed cookie, so it holds even without a durable store.
//   2. Email unlock: once a visitor leaves an email (POST /api/unlock) the
//      cookie carries `email: true` and the per-session limit is lifted.
//   3. Per IP: IP_FREE_MS in total across every session from that IP within
//      IP_WINDOW_S. Kept per session id in the store, keyed on the hashed IP,
//      so clearing the cookie starts a new 5-minute session but never resets
//      the IP total. Durable only when Upstash is configured (lib/store.js).
//
// COOKIE: an HMAC-signed, base64url JSON token: `${data}.${sig}`. We embed an
//   `exp` (ms epoch) and reject expired tokens on verify() to limit replay.

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { cookieSameSite } from './cors.js';
import { get as storeGet, set as storeSet } from './store.js';

// ---- Shared constants (previously duplicated across every handler) ----------
export const COOKIE_NAME = 'sx_session';
const minutes = (v, d) => (Number(v) > 0 ? Number(v) : d) * 60 * 1000;
export const SESSION_FREE_MS = minutes(process.env.SESSION_FREE_MINUTES, 5);  // per session, before email
export const IP_FREE_MS = minutes(process.env.IP_FREE_MINUTES, 30);           // per IP, all sessions
export const FREE_DURATION_MS = SESSION_FREE_MS;                              // kept for older callers
export const COOKIE_MAX_AGE_S = 24 * 60 * 60;           // cookie lifetime
const COOKIE_EXP_MS = COOKIE_MAX_AGE_S * 1000;          // token freshness window
// How long an IP's usage is remembered. After this window the IP gets a fresh
// IP_FREE_MS allowance.
const IP_BUDGET_TTL_S = (Number(process.env.IP_WINDOW_HOURS) > 0 ? Number(process.env.IP_WINDOW_HOURS) : 24) * 60 * 60;
const MAX_TRACKED_SESSIONS = 40;

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

// ---- Budget ----------------------------------------------------------------
// Pure budget maths for a session + the IP's usage record.
function computeBudget(session, rec, now) {
  const started = typeof session.startedAt === 'number' && session.startedAt > 0;
  const sessionUsedMs = started ? Math.max(0, now - session.startedAt) : 0;

  let ipUsedMs = 0;
  for (const [sid, span] of Object.entries(rec.s || {})) {
    if (sid === session.id) continue;
    ipUsedMs += Math.max(0, span[1] - span[0]);
  }
  ipUsedMs += sessionUsedMs;

  const emailUnlocked = !!session.email;
  const sessionRemainingMs = emailUnlocked ? Infinity : SESSION_FREE_MS - sessionUsedMs;
  const ipRemainingMs = IP_FREE_MS - ipUsedMs;
  const freeRemainingMs = Math.max(0, Math.min(sessionRemainingMs, ipRemainingMs));
  const paidActive = !!session.paid && session.paidUntil > now;
  const totalRemainingMs = paidActive ? Math.max(freeRemainingMs, session.paidUntil - now) : freeRemainingMs;
  // Out of session time but the IP still has some: an email gets them more.
  const needsEmail = !paidActive && !emailUnlocked && sessionRemainingMs <= 0 && ipRemainingMs > 0;
  // What the UI shows as "used / limit" for this session.
  const limitMs = Math.max(0, emailUnlocked ? sessionUsedMs + Math.max(0, ipRemainingMs) : Math.min(SESSION_FREE_MS, sessionUsedMs + Math.max(0, ipRemainingMs)));

  return {
    started, sessionUsedMs, limitMs, ipUsedMs, ipRemainingMs: Math.max(0, ipRemainingMs),
    emailUnlocked, needsEmail, freeRemainingMs, paidActive, totalRemainingMs,
  };
}

const ipKey = (req) => `budget2:${hashIp(clientIp(req))}`;
async function readIpRecord(req) {
  const rec = await storeGet(ipKey(req));
  return rec && typeof rec === 'object' && rec.s ? rec : { s: {} };
}

function sessionFromCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verify(cookies[COOKIE_NAME]);
  return { session: session || newSession(), hasSession: !!session };
}

// Called by chat/voice/transcribe: starts the session clock on first use and
// records this session's span against the IP. Caller must setSessionCookie().
export async function loadBudget(req, now = Date.now()) {
  const { session } = sessionFromCookie(req);
  if (!(session.startedAt > 0)) session.startedAt = now;

  const rec = await readIpRecord(req);
  rec.s[session.id] = [session.startedAt, now];
  const ids = Object.keys(rec.s);
  if (ids.length > MAX_TRACKED_SESSIONS) {
    // Fold the oldest spans into a single bucket so the record stays small.
    ids.sort((a, b) => rec.s[a][1] - rec.s[b][1]);
    let folded = rec.s._old ? rec.s._old[1] - rec.s._old[0] : 0;
    for (const id of ids.slice(0, ids.length - MAX_TRACKED_SESSIONS)) {
      if (id === '_old') continue;
      folded += Math.max(0, rec.s[id][1] - rec.s[id][0]);
      delete rec.s[id];
    }
    rec.s._old = [0, folded];
  }
  await storeSet(ipKey(req), rec, IP_BUDGET_TTL_S);

  return { session, ...computeBudget(session, rec, now) };
}

// Read-only snapshot (GET /api/session): never starts the clock.
export async function peekBudget(req, now = Date.now()) {
  const { session, hasSession } = sessionFromCookie(req);
  const rec = await readIpRecord(req);
  const b = computeBudget(session, rec, now);
  return { session, hasSession, seen: b.started || b.ipUsedMs > 0, firstSeenAt: session.startedAt || null, ...b };
}

// Budget for an explicit session object (used right after /api/unlock flips
// the email flag, before the new cookie has round-tripped).
export async function budgetForSession(req, session, now = Date.now()) {
  const rec = await readIpRecord(req);
  return computeBudget(session, rec, now);
}

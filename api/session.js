import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'sx_session';
const FREE_DURATION_MS = 3 * 60 * 1000;

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET missing');
  return s;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = createHmac('sha256', getSecret()).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); }
  catch { return null; }
}

function parseCookies(header) {
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const cookies = parseCookies(req.headers.cookie);
  const session = verify(cookies[COOKIE_NAME]);
  const now = Date.now();

  if (!session) {
    return res.status(200).json({
      hasSession: false,
      remainingMs: FREE_DURATION_MS,
      freeBudgetMs: FREE_DURATION_MS,
      paid: false,
    });
  }

  const elapsed = now - session.startedAt;
  const freeRemaining = Math.max(0, FREE_DURATION_MS - elapsed);
  const paidActive = session.paid && session.paidUntil > now;
  const remainingMs = paidActive
    ? Math.max(freeRemaining, session.paidUntil - now)
    : freeRemaining;

  return res.status(200).json({
    hasSession: true,
    remainingMs,
    freeBudgetMs: FREE_DURATION_MS,
    paid: paidActive,
    startedAt: session.startedAt,
  });
}

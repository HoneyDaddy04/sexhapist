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

function clearCookie(res) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; '));
}

// POST /api/reset
// Clears the session cookie ONLY if the existing session is expired
// (so a mid-session refresh doesn't lose the user's ongoing free time).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const cookies = parseCookies(req.headers.cookie);
  const session = verify(cookies[COOKIE_NAME]);

  if (!session) {
    return res.status(200).json({ status: 'no_session' });
  }

  const now = Date.now();
  const elapsed = now - session.startedAt;
  const paidActive = session.paid && session.paidUntil > now;

  if (elapsed > FREE_DURATION_MS && !paidActive) {
    clearCookie(res);
    return res.status(200).json({ status: 'reset' });
  }

  return res.status(200).json({ status: 'kept' });
}
